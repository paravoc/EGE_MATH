const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const NODE_MODULES_DIR =
  process.env.CODEX_BUNDLED_NODE_MODULES ||
  "C:\\Users\\smirn\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules";

const packageRequire = createRequire(path.join(NODE_MODULES_DIR, "__codex__.js"));
const { createCanvas } = packageRequire("@napi-rs/canvas");
const sharp = packageRequire("sharp");

const PDFJS_MODULE_URL = pathToFileURL(
  path.join(NODE_MODULES_DIR, "pdfjs-dist", "legacy", "build", "pdf.mjs"),
).href;

const OUTPUT_HTML_NAME = "ege_math_study_guide.html";
const OUTPUT_ASSETS_DIR_NAME = "ege_math_study_guide_assets";
const FIRST_CONTENT_PAGE = 4;
const PREVIEW_WIDTH = 1040;
const PREVIEW_CROP_RATIOS = {
  top: 0.082,
  bottom: 0.095,
  left: 0.05,
  right: 0.05,
};

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    const context = canvas.getContext("2d");

    return { canvas, context };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = Math.ceil(width);
    canvasAndContext.canvas.height = Math.ceil(height);
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

function findSourcePdf(baseDir) {
  const pdfFiles = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => path.join(baseDir, entry.name));

  const preferred = pdfFiles.find((filePath) => /шпора/i.test(path.basename(filePath)));
  return preferred || pdfFiles[0] || null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^a-zа-я0-9]+/giu, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeTaskLabel(rawText) {
  const match = rawText.replaceAll("Заданиe", "Задание").match(/Задани[^\s]*\s+(\d+(?:\s*-\s*\d+)?)/iu);
  if (!match) {
    return null;
  }

  const range = match[1].replace(/\s+/g, "");
  return range.includes("-") ? `Задания ${range}` : `Задание ${range}`;
}

function cleanInlineText(text) {
  return text
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([(\[«])\s+/g, "$1")
    .replace(/\s+([)\]»])/g, "$1")
    .replace(/\s*—\s*/g, " — ")
    .replace(/\s{2,}/g, " ")
    .replace(/(\d)\s+°/g, "$1°")
    .trim();
}

function adaptLineText(text) {
  return cleanInlineText(text)
    .replace(/^Определение\.\s*/u, "")
    .replace(/^Примечание:\s*/u, "Важно: ");
}

function joinLineItems(items) {
  const ordered = [...items].sort((left, right) => left.x - right.x);
  let result = "";
  let previous = null;

  for (const item of ordered) {
    const text = item.str.replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }

    if (!previous) {
      result = text;
      previous = item;
      continue;
    }

    const previousRight = previous.x + (previous.width || 0);
    const gap = item.x - previousRight;
    const needsSpace =
      gap > 2.2 &&
      !/^[,.;:!?°)\]»]/u.test(text) &&
      !/[([«/]$/u.test(result) &&
      !/^[+\-=:]/u.test(text);

    result += needsSpace ? ` ${text}` : text;
    previous = item;
  }

  return cleanInlineText(result);
}

function extractLines(items) {
  const ordered = [...items]
    .filter((item) => item.str && item.str.trim())
    .map((item) => ({
      str: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width || 0,
    }))
    .sort((left, right) => {
      const yDelta = Math.abs(right.y - left.y);
      if (yDelta <= 2.5) {
        return left.x - right.x;
      }

      return right.y - left.y;
    });

  const lines = [];
  for (const item of ordered) {
    const currentLine = lines.find((line) => Math.abs(line.y - item.y) <= 2.5);
    if (currentLine) {
      currentLine.items.push(item);
      continue;
    }

    lines.push({ y: item.y, items: [item] });
  }

  return lines
    .sort((left, right) => right.y - left.y)
    .map((line) => ({
      y: line.y,
      text: joinLineItems(line.items),
      minX: Math.min(...line.items.map((item) => item.x)),
    }))
    .filter((line) => line.text);
}

function isHeaderOrFooter(text) {
  return (
    /Профиматика\s*\|\s*Запись на курсы/iu.test(text) ||
    /^Содержание\s*\|\s*\d+/iu.test(text) ||
    /^W(?:\s*W)+$/iu.test(text) ||
    /^\d+$/u.test(text)
  );
}

function isFormulaLine(text) {
  if (text.length > 140) {
    return false;
  }

  const hasMathSymbols = /[=√π°±<>≤≥^/*+\-]|sin|cos|tg|ctg|log|ln|mod|∠|△|⇔|⌣/iu.test(text);
  const hasDigits = /\d/u.test(text);
  const endsLikeSentence = /[.!?]$/u.test(text);

  return hasMathSymbols && hasDigits && !endsLikeSentence;
}

function isNoiseLine(text) {
  const compact = text.replace(/\s+/g, "");
  if (!compact) {
    return true;
  }

  if (/^[⃗√]$/u.test(compact)) {
    return true;
  }

  if (/^[A-Z]+D?⃗?$/u.test(compact) && compact.length >= 8) {
    return true;
  }

  if (/^[A-Z⃗\s]+$/u.test(text) && compact.length >= 8) {
    return true;
  }

  if (!/[а-яёa-z]/iu.test(compact) && compact.length <= 2) {
    return true;
  }

  return false;
}

function isContinuationTitle(text) {
  return (
    /^Пример\b/iu.test(text) ||
    /^Шаг\s+\d+/iu.test(text) ||
    /^\d+[.)]/u.test(text) ||
    /^[а-яё]/u.test(text) ||
    /^Также\b/iu.test(text) ||
    /^При этом\b/iu.test(text) ||
    /^Действительно\b/iu.test(text) ||
    /^Следовательно\b/iu.test(text) ||
    /^Важно:/iu.test(text)
  );
}

function extractDefinitionTitle(lines) {
  const combined = lines
    .slice(0, 2)
    .map((line) => line.text)
    .join(" ");

  const match = combined.match(/^Определение\.\s*([^-—–:.]{2,80})\s*[-—–]/u);
  if (!match) {
    return null;
  }

  return cleanInlineText(match[1]);
}

function deriveSentenceTitle(lines) {
  const firstText = lines[0]?.text;
  if (!firstText || isContinuationTitle(firstText) || !/[А-ЯЁа-яё]{3,}/u.test(firstText)) {
    return null;
  }

  const fragment = cleanInlineText(firstText.split(/[,:;]/u)[0]);
  if (fragment.length < 8 || fragment.length > 80) {
    return null;
  }

  if (/^(Решением|Обратная|Теорема|Формула|Свойство|Признак|Решение)(?:\s|$)/u.test(fragment)) {
    return fragment;
  }

  return null;
}

function detectTitle(lines) {
  if (lines.length === 0) {
    return { title: null, startIndex: 0, isContinuation: true };
  }

  const definitionTitle = extractDefinitionTitle(lines);
  if (definitionTitle) {
    return { title: definitionTitle, startIndex: 0, isContinuation: false };
  }

  const sentenceTitle = deriveSentenceTitle(lines);
  if (sentenceTitle) {
    return { title: sentenceTitle, startIndex: 1, isContinuation: false };
  }

  const [firstLine, secondLine] = lines;
  if (!firstLine) {
    return { title: null, startIndex: 0, isContinuation: true };
  }

  const firstText = firstLine.text;
  const secondText = secondLine?.text || "";
  const secondStartsLowercaseSentence =
    !!secondText &&
    /^[а-яё]/u.test(secondText) &&
    !isFormulaLine(secondText);
  const hasCyrillicWord = /[А-ЯЁа-яё]{3,}/u.test(firstText);
  const hasEquation = /=/u.test(firstText);
  const looksFormulaHeavy = /[√π≤≥±]/u.test(firstText) && !hasCyrillicWord;
  const endsLikeBrokenSentence = /[,;]$/u.test(firstText);

  const looksLikeTitle =
    firstText.length <= 90 &&
    !/[.!?]$/u.test(firstText) &&
    !endsLikeBrokenSentence &&
    !isContinuationTitle(firstText) &&
    hasCyrillicWord &&
    !hasEquation &&
    !looksFormulaHeavy &&
    !secondStartsLowercaseSentence;

  if (looksLikeTitle) {
    return { title: firstText, startIndex: 1, isContinuation: false };
  }

  return { title: null, startIndex: 0, isContinuation: true };
}

function buildPageRecord(pageNumber, lines, currentTaskLabel) {
  const filteredLines = lines.filter((line) => !isHeaderOrFooter(line.text));

  let taskLabel = currentTaskLabel;
  const taskLine = filteredLines.find((line) => normalizeTaskLabel(line.text));
  if (taskLine) {
    taskLabel = normalizeTaskLabel(taskLine.text);
  }

  const contentLines = filteredLines.filter((line) => line !== taskLine);
  const meaningfulLines = contentLines.filter((line) => !isNoiseLine(line.text));
  const titleInfo = detectTitle(meaningfulLines);
  const blocks = meaningfulLines
    .slice(titleInfo.startIndex)
    .map((line) => {
      const adapted = adaptLineText(line.text);
      return {
        kind: isFormulaLine(adapted) ? "formula" : "text",
        text: adapted,
      };
    })
    .filter((block) => block.text);

  return {
    pageNumber,
    taskLabel: taskLabel || "Без раздела",
    title: titleInfo.title,
    isContinuation: titleInfo.isContinuation,
    blocks,
    searchText: meaningfulLines.map((line) => adaptLineText(line.text)).join(" "),
  };
}

function isPromotionalPage(lines) {
  const pageText = lines.map((line) => line.text).join(" ").toLowerCase().replaceAll("ё", "е");

  const stopPatterns = [
    "ты добрался до конца книги",
    "команда профиматики",
    "записывайся на наш курс",
    "промокод на скидку",
    "ты еще тут",
    "каналах для преподавателей",
    "ссылки профиматика",
    "заключение профиматика",
  ];

  return stopPatterns.some((pattern) => pageText.includes(pattern));
}

function buildSummary(blocks) {
  const textBlocks = blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.text);

  if (textBlocks.length === 0) {
    return "На этой карточке удобнее смотреть формулы и оригинальные иллюстрации из PDF.";
  }

  let summary = "";
  for (const block of textBlocks) {
    if ((summary + block).length > 300) {
      break;
    }

    summary = summary ? `${summary} ${block}` : block;
    if ((summary.match(/[.!?]/g) || []).length >= 2) {
      break;
    }
  }

  return summary || textBlocks[0];
}

function buildTopicDescription(topic) {
  const textBlocks = topic.blocks.filter((block) => block.kind === "text").map((block) => block.text);
  const formulaBlocks = topic.blocks.filter((block) => block.kind === "formula").map((block) => block.text);
  const textLength = textBlocks.join(" ").length;
  const title = topic.title || "эта тема";
  const normalizedTitle = title.toLowerCase().replaceAll("ё", "е");

  if (textBlocks.length >= 3 && textLength >= 260) {
    return null;
  }

  const descriptionRules = [
    {
      pattern: /таблица значений.*тригонометр|основных тригонометрических углов/u,
      text:
        "Здесь собраны готовые значения sin, cos, tg и ctg для основных углов. Этот блок полезен для быстрого повторения и мгновенной проверки ответов в задачах.",
    },
    {
      pattern: /формулы площад|площадь/u,
      text:
        "Здесь собраны основные способы находить площадь фигуры через сторону, высоту, угол и другие известные элементы. Удобно быстро вспомнить, какая формула подходит под условие задачи.",
    },
    {
      pattern: /куб|параллелепипед|призма|пирамида|конус|цилиндр|шар|сфера/u,
      text:
        "Это короткая опора по формулам для пространственных фигур: длины, площади и объёмы. Сначала определи нужное тело, а затем выбери подходящее соотношение из записей ниже.",
    },
    {
      pattern: /решением уравнения sin|решением уравнения cos|решением уравнения tg|решением уравнения ctg/u,
      text:
        "Здесь дана общая схема решения тригонометрического уравнения. Смотри на вид функции, подставляй значение и обязательно учитывай период при записи ответа.",
    },
    {
      pattern: /теорема/u,
      text:
        "В этом фрагменте собрана теорема и её ключевое следствие. Сначала запомни смысл утверждения, а затем используй формулу или рисунок как быструю опору.",
    },
    {
      pattern: /признак/u,
      text:
        "Здесь перечислены признаки, по которым можно быстро распознать нужную ситуацию в задаче. Полезно сначала понять идею признака, а уже потом запоминать запись и рисунок.",
    },
    {
      pattern: /вектор|скалярное произведение|правило параллелограмма/u,
      text:
        "Этот блок помогает быстро вспомнить, как работать с векторами: что означают координаты, как складывать векторы и как использовать основные свойства в решении задач.",
    },
    {
      pattern: /вероятност|бернулли|комбинатор/u,
      text:
        "Здесь собраны базовые вероятностные соотношения. Удобно сначала определить тип события или эксперимента, а затем выбрать нужную формулу.",
    },
    {
      pattern: /производн|касательн|экстремум|монотон/u,
      text:
        "В этой теме собраны основные идеи по исследованию функции: где она растёт или убывает, как искать экстремумы и как использовать производную в задачах.",
    },
    {
      pattern: /логарифм|показательн|степен/u,
      text:
        "Здесь собраны основные свойства и формулы преобразований. Их удобно использовать как памятку при упрощении выражений и решении уравнений.",
    },
    {
      pattern: /окружност|угол|треугольник|трапец|параллелограмм|ромб|квадрат/u,
      text:
        "Это краткая геометрическая опора по теме: рисунок помогает увидеть конфигурацию, а записи ниже напоминают главное свойство или соотношение между элементами фигуры.",
    },
  ];

  for (const rule of descriptionRules) {
    if (rule.pattern.test(normalizedTitle)) {
      return rule.text;
    }
  }

  if (formulaBlocks.length === 0) {
    return null;
  }

  if (textBlocks.length === 0) {
    return `Здесь собраны ключевые формулы и соотношения по теме «${title}». Их удобно использовать как короткую шпаргалку для повторения перед задачами этого типа.`;
  }

  if (textLength < 180 || formulaBlocks.length >= textBlocks.length) {
    return `Короткая опора по теме «${title}»: сначала вспомни смысл величин и связи между ними, а затем используй формулы ниже как готовую памятку.`;
  }

  return null;
}

function buildTopicRange(pages) {
  const first = pages[0];
  const last = pages[pages.length - 1];
  return first === last ? `стр. ${first}` : `стр. ${first}-${last}`;
}

function pluralizeRussian(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return few;
  }

  return many;
}

function renderBlocks(blocks, descriptionText = null) {
  let hasLead = false;
  const rendered = [];

  if (descriptionText) {
    rendered.push(`<p class="topic-lead topic-note">${escapeHtml(descriptionText)}</p>`);
    hasLead = true;
  }

  rendered.push(
    ...blocks.map((block) => {
      if (block.kind === "formula") {
        return `<div class="formula-line">${escapeHtml(block.text)}</div>`;
      }

      const className = hasLead ? "topic-paragraph" : "topic-lead";
      hasLead = true;
      return `<p class="${className}">${escapeHtml(block.text)}</p>`;
    }),
  );

  return rendered.join("\n");
}

function renderPreviewFigure(pageNumber, sourcePdfName) {
  const previewPath = `${OUTPUT_ASSETS_DIR_NAME}/page-${String(pageNumber).padStart(3, "0")}.webp`;
  const pageAnchor = `${sourcePdfName}#page=${pageNumber}`;

  return `
    <figure class="preview-figure">
      <span class="preview-page">стр. ${pageNumber}</span>
      <a href="${escapeAttr(pageAnchor)}">
        <img loading="lazy" src="${escapeAttr(previewPath)}" alt="Иллюстрация со страницы ${pageNumber}">
      </a>
    </figure>
  `;
}

function renderPreviewGroup(topic, sourcePdfName) {
  const [firstPage, ...extraPages] = topic.pages;
  const extraLabel = `${extraPages.length} ${pluralizeRussian(extraPages.length, "страница", "страницы", "страниц")}`;

  return `
    <aside class="topic-visuals">
      <div class="visual-head">
        <span class="visual-kicker">Иллюстрация из PDF</span>
        <a class="pdf-link" href="${escapeAttr(`${sourcePdfName}#page=${firstPage}`)}">Открыть в PDF</a>
      </div>
      ${renderPreviewFigure(firstPage, sourcePdfName)}
      ${
        extraPages.length
          ? `
            <details class="preview-more">
              <summary>Ещё ${extraLabel}</summary>
              <div class="preview-extra">
                ${extraPages.map((pageNumber) => renderPreviewFigure(pageNumber, sourcePdfName)).join("\n")}
              </div>
            </details>
          `
          : ""
      }
    </aside>
  `;
}

function buildHtml({ topicsByTask, sourcePdfName, totalTopics, totalPages }) {
  const taskEntries = [...topicsByTask.entries()].map(([taskLabel, topics]) => {
    const taskId = `task-${slugify(taskLabel)}`;
    const firstPage = topics[0]?.pages[0] ?? 0;
    const lastTopic = topics[topics.length - 1];
    const lastPage = lastTopic?.pages[lastTopic.pages.length - 1] ?? firstPage;
    const sectionRange = firstPage === lastPage ? `стр. ${firstPage}` : `стр. ${firstPage}-${lastPage}`;

    return {
      taskId,
      taskLabel,
      topics,
      sectionRange,
    };
  });

  const chipButtons = [
    `<button class="filter-chip active" type="button" data-task="all"><span>Все темы</span><strong>${totalTopics}</strong></button>`,
    ...taskEntries.map(({ taskLabel, topics }) => {
      return `
        <button class="filter-chip" type="button" data-task="${escapeAttr(taskLabel)}">
          <span>${escapeHtml(taskLabel)}</span>
          <strong>${topics.length}</strong>
        </button>
      `;
    }),
  ].join("\n");

  const jumpLinks = taskEntries
    .map(({ taskId, taskLabel, sectionRange, topics }) => {
      return `
        <a class="jump-link" href="#${escapeAttr(taskId)}" data-task-link="${escapeAttr(taskLabel)}">
          <span>${escapeHtml(taskLabel)}</span>
          <em>${topics.length} · ${escapeHtml(sectionRange)}</em>
        </a>
      `;
    })
    .join("\n");

  const sectionHtml = taskEntries
    .map(({ taskId, taskLabel, topics, sectionRange }) => {
      const articles = topics
        .map((topic) => {
          return `
            <article class="topic-entry" data-task="${escapeAttr(taskLabel)}" data-search="${escapeAttr(
              topic.searchIndex,
            )}">
              <div class="topic-meta">
                <span class="topic-task">${escapeHtml(taskLabel)}</span>
                <span class="topic-range">${escapeHtml(topic.pageRange)}</span>
              </div>
              <h3>${escapeHtml(topic.title)}</h3>
              <div class="topic-layout">
                <div class="topic-text">
                  ${renderBlocks(topic.blocks, topic.description)}
                </div>
                ${renderPreviewGroup(topic, sourcePdfName)}
              </div>
            </article>
          `;
        })
        .join("\n");

      return `
        <section class="task-section" id="${escapeAttr(taskId)}" data-task-section="${escapeAttr(taskLabel)}">
          <header class="task-header">
            <div>
              <span class="section-kicker">Раздел</span>
              <h2>${escapeHtml(taskLabel)}</h2>
            </div>
            <p class="task-caption">${topics.length} ${pluralizeRussian(
              topics.length,
              "тема",
              "темы",
              "тем",
            )} · ${escapeHtml(sectionRange)}</p>
          </header>
          <div class="topic-flow">
            ${articles}
          </div>
        </section>
      `;
    })
    .join("\n");

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Профильная математика: тёмный конспект</title>
    <style>
      :root {
        --bg: #060913;
        --bg-strong: #0a1020;
        --bg-soft: rgba(15, 21, 35, 0.72);
        --ink: #edf2ff;
        --ink-soft: #d7def1;
        --muted: #8f9ab2;
        --line: rgba(143, 154, 178, 0.16);
        --line-strong: rgba(143, 154, 178, 0.3);
        --accent: #74e3ff;
        --accent-strong: #ffc170;
        --accent-soft: rgba(116, 227, 255, 0.12);
        --shadow: 0 30px 80px rgba(0, 0, 0, 0.44);
        font-family: "Segoe UI Variable Display", "Trebuchet MS", "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      html {
        scroll-behavior: smooth;
      }

      body {
        margin: 0;
        color: var(--ink);
        background:
          radial-gradient(circle at 14% 0%, rgba(116, 227, 255, 0.14), transparent 28%),
          radial-gradient(circle at 100% 8%, rgba(255, 193, 112, 0.12), transparent 24%),
          linear-gradient(180deg, #05070d 0%, #09101a 38%, #060a12 100%);
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background:
          linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
        background-size: 44px 44px;
        mask-image: radial-gradient(circle at center, black 45%, transparent 95%);
        opacity: 0.22;
      }

      a {
        color: inherit;
      }

      .page-shell {
        width: min(1480px, calc(100% - 28px));
        margin: 0 auto;
        padding: 26px 0 72px;
      }

      .masthead {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 24px;
        align-items: end;
        padding-bottom: 24px;
        border-bottom: 1px solid var(--line);
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        color: var(--accent);
        font-size: 0.88rem;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .eyebrow::before {
        content: "";
        width: 34px;
        height: 1px;
        background: linear-gradient(90deg, transparent, var(--accent));
      }

      h1 {
        margin: 18px 0 14px;
        max-width: 12ch;
        font-size: clamp(2.4rem, 5vw, 4.8rem);
        line-height: 0.96;
        letter-spacing: -0.05em;
      }

      .subtitle {
        max-width: 64rem;
        margin: 0;
        color: var(--muted);
        font-size: 1.06rem;
        line-height: 1.8;
      }

      .source-note {
        max-width: 58rem;
        margin: 18px 0 0;
        padding: 14px 16px;
        border-left: 2px solid rgba(255, 193, 112, 0.5);
        border-radius: 0 14px 14px 0;
        background: linear-gradient(90deg, rgba(255, 193, 112, 0.1), transparent 74%);
        color: var(--ink-soft);
        font-size: 0.98rem;
        line-height: 1.7;
      }

      .masthead-side {
        display: grid;
        justify-items: end;
        gap: 14px;
      }

      .open-pdf,
      .pdf-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 0 18px;
        border-radius: 999px;
        background: linear-gradient(135deg, rgba(116, 227, 255, 0.16), rgba(255, 193, 112, 0.16));
        color: var(--ink);
        text-decoration: none;
        font-weight: 700;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
        transition: transform 0.18s ease, opacity 0.18s ease;
      }

      .open-pdf:hover,
      .pdf-link:hover {
        transform: translateY(-1px);
        opacity: 0.95;
      }

      .hero-stats {
        display: flex;
        flex-wrap: wrap;
        justify-content: end;
        gap: 10px;
        color: var(--muted);
        font-size: 0.95rem;
      }

      .workspace {
        display: grid;
        grid-template-columns: minmax(240px, 280px) minmax(0, 1fr);
        gap: clamp(28px, 4vw, 56px);
        margin-top: 30px;
      }

      .navigator {
        position: sticky;
        top: 18px;
        align-self: start;
        display: grid;
        gap: 18px;
      }

      .control-block {
        padding-bottom: 18px;
        border-bottom: 1px solid var(--line);
      }

      .block-title,
      .search-title {
        display: block;
        margin-bottom: 12px;
        color: var(--muted);
        font-size: 0.83rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .search-box {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
      }

      #searchInput {
        width: 100%;
        min-height: 50px;
        padding: 0 16px;
        border: 1px solid rgba(143, 154, 178, 0.2);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.04);
        color: var(--ink);
        font: inherit;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
      }

      #searchInput::placeholder {
        color: rgba(237, 242, 255, 0.42);
      }

      #searchInput:focus {
        outline: none;
        border-color: rgba(116, 227, 255, 0.44);
        box-shadow: 0 0 0 4px rgba(116, 227, 255, 0.08);
      }

      .search-clear {
        min-height: 44px;
        padding: 0 14px;
        border: 1px solid rgba(143, 154, 178, 0.22);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.04);
        color: var(--ink-soft);
        font: inherit;
        cursor: pointer;
        transition: border-color 0.16s ease, color 0.16s ease, background 0.16s ease;
      }

      .search-clear:hover {
        border-color: rgba(116, 227, 255, 0.3);
        color: var(--ink);
        background: rgba(116, 227, 255, 0.06);
      }

      .search-hint {
        margin-top: 10px;
        color: var(--muted);
        font-size: 0.85rem;
        line-height: 1.45;
      }

      .toggle {
        display: inline-flex;
        gap: 10px;
        align-items: center;
        color: var(--ink-soft);
        line-height: 1.5;
      }

      .toggle input {
        inline-size: 18px;
        block-size: 18px;
        accent-color: var(--accent);
      }

      .filters {
        display: grid;
        gap: 8px;
      }

      .filter-chip {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--muted);
        font: inherit;
        text-align: left;
        cursor: pointer;
        transition: transform 0.16s ease, color 0.16s ease;
      }

      .filter-chip span {
        display: inline-flex;
        align-items: center;
        gap: 12px;
      }

      .filter-chip span::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: rgba(143, 154, 178, 0.34);
      }

      .filter-chip strong {
        color: rgba(237, 242, 255, 0.42);
        font-size: 0.86rem;
      }

      .filter-chip.active,
      .filter-chip:hover {
        color: var(--ink);
        transform: translateX(2px);
      }

      .filter-chip.active span::before,
      .filter-chip:hover span::before {
        background: var(--accent);
        box-shadow: 0 0 18px rgba(116, 227, 255, 0.55);
      }

      .filter-chip.active strong,
      .filter-chip:hover strong {
        color: var(--accent);
      }

      .jump-list {
        display: grid;
        gap: 10px;
      }

      .jump-link {
        display: grid;
        gap: 2px;
        color: var(--ink-soft);
        text-decoration: none;
        transition: transform 0.16s ease, color 0.16s ease;
      }

      .jump-link em {
        color: var(--muted);
        font-style: normal;
        font-size: 0.85rem;
      }

      .jump-link:hover {
        transform: translateX(2px);
        color: var(--accent);
      }

      .status-line {
        color: var(--muted);
        font-size: 0.94rem;
      }

      .reader {
        min-width: 0;
      }

      .task-section + .task-section {
        margin-top: 76px;
        padding-top: 76px;
        border-top: 1px solid var(--line);
      }

      .task-header {
        display: flex;
        justify-content: space-between;
        align-items: end;
        gap: 24px;
        margin-bottom: 28px;
      }

      .section-kicker {
        color: var(--accent-strong);
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 0.82rem;
        font-weight: 700;
      }

      h2 {
        margin: 10px 0 0;
        font-size: clamp(1.9rem, 3vw, 2.9rem);
        line-height: 1;
      }

      .task-caption {
        margin: 0;
        color: var(--muted);
        text-align: right;
      }

      .topic-flow {
        display: grid;
        gap: 48px;
      }

      .topic-entry {
        position: relative;
      }

      .topic-entry.search-match {
        scroll-margin-top: 22px;
      }

      .topic-entry + .topic-entry {
        padding-top: 44px;
        border-top: 1px solid rgba(143, 154, 178, 0.12);
      }

      .topic-entry::before {
        content: "";
        position: absolute;
        left: -18px;
        top: 6px;
        width: 2px;
        height: 52px;
        background: linear-gradient(180deg, var(--accent), transparent);
        opacity: 0.45;
      }

      .topic-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        color: var(--muted);
        font-size: 0.92rem;
      }

      .topic-task {
        display: inline-flex;
        align-items: center;
        padding: 5px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-weight: 700;
      }

      .topic-range {
        color: var(--muted);
      }

      h3 {
        margin: 14px 0 18px;
        max-width: 24ch;
        font-size: clamp(1.38rem, 2vw, 2.05rem);
        line-height: 1.12;
      }

      .topic-layout {
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
        gap: clamp(24px, 3vw, 40px);
        align-items: start;
      }

      .topic-text {
        display: grid;
        gap: 14px;
        min-width: 0;
      }

      .topic-lead,
      .topic-paragraph {
        margin: 0;
        color: var(--ink-soft);
        font-size: 1.03rem;
        line-height: 1.82;
      }

      .topic-lead {
        color: var(--ink);
        font-size: 1.12rem;
      }

      .topic-note {
        padding: 14px 16px;
        border-left: 2px solid rgba(255, 193, 112, 0.5);
        border-radius: 0 14px 14px 0;
        background: linear-gradient(90deg, rgba(255, 193, 112, 0.08), transparent 72%);
      }

      .formula-line {
        padding: 14px 16px;
        border-left: 2px solid rgba(116, 227, 255, 0.5);
        border-radius: 0 16px 16px 0;
        background: linear-gradient(90deg, rgba(116, 227, 255, 0.08), transparent 72%);
        color: #d8fbff;
        font-family: "Cascadia Mono", "Consolas", monospace;
        font-size: 0.96rem;
        overflow-x: auto;
      }

      .search-hit {
        padding: 0 0.18em;
        border-radius: 0.32em;
        background: rgba(255, 193, 112, 0.22);
        color: #fff6dd;
        box-shadow: 0 0 0 1px rgba(255, 193, 112, 0.18);
      }

      .topic-visuals {
        display: grid;
        gap: 16px;
        align-content: start;
      }

      .visual-head {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        align-items: center;
      }

      .visual-kicker {
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .preview-figure {
        position: relative;
        margin: 0;
      }

      .preview-page {
        position: absolute;
        z-index: 1;
        top: 14px;
        left: 14px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(7, 11, 18, 0.7);
        color: #eef7ff;
        font-size: 0.82rem;
        backdrop-filter: blur(12px);
      }

      .preview-figure a {
        display: block;
      }

      .preview-figure img {
        display: block;
        width: 100%;
        height: auto;
        border-radius: 28px;
        box-shadow: var(--shadow);
      }

      .preview-more {
        padding-top: 4px;
      }

      .preview-more summary {
        cursor: pointer;
        color: var(--accent);
        font-weight: 700;
      }

      .preview-extra {
        display: grid;
        gap: 16px;
        margin-top: 14px;
      }

      .pdf-link {
        white-space: nowrap;
      }

      body[data-previews="off"] .topic-layout {
        grid-template-columns: minmax(0, 1fr);
      }

      body[data-previews="off"] .topic-visuals {
        display: none;
      }

      [hidden] {
        display: none !important;
      }

      @media (max-width: 1080px) {
        .workspace {
          grid-template-columns: 1fr;
        }

        .navigator {
          position: static;
          order: -1;
        }
      }

      @media (max-width: 860px) {
        .page-shell {
          width: min(100% - 18px, 1480px);
          padding-top: 18px;
        }

        .masthead {
          grid-template-columns: 1fr;
        }

        .masthead-side {
          justify-items: start;
        }

        .hero-stats {
          justify-content: start;
        }

        .task-header {
          flex-direction: column;
          align-items: start;
        }

        .task-caption {
          text-align: left;
        }

        .topic-entry::before {
          display: none;
        }

        .topic-layout {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body data-previews="on">
    <div class="page-shell">
      <header class="masthead">
        <div>
          <span class="eyebrow">ЕГЭ профиль · тёмный конспект</span>
          <h1>Профильная математика для быстрого повторения</h1>
          <p class="subtitle">Темы теперь идут единым читательским потоком, а страницы из PDF встроены прямо рядом с теорией. Верхние и нижние служебные полосы у иллюстраций обрезаны, чтобы не мешать просмотру.</p>
          <p class="source-note">Ремарка: этот конспект собран на основе стороннего PDF-источника. Исходные формулировки, схемы и иллюстрации не являются моим авторским учебным материалом.</p>
        </div>
        <div class="masthead-side">
          <a class="open-pdf" href="${escapeAttr(sourcePdfName)}">Открыть исходный PDF</a>
          <div class="hero-stats">
            <span>${totalTopics} ${pluralizeRussian(totalTopics, "тема", "темы", "тем")}</span>
            <span>${totalPages} страниц теории</span>
          </div>
        </div>
      </header>

      <div class="workspace">
        <aside class="navigator">
          <section class="control-block">
            <label class="search-title" for="searchInput">Поиск по материалу</label>
            <div class="search-box">
              <input id="searchInput" type="search" placeholder="Теорема, термин, формула, задача">
              <button id="clearSearchButton" class="search-clear" type="button" hidden>Сбросить</button>
            </div>
            <div class="search-hint">Можно искать по нескольким словам сразу. Например: <code>вписанный угол</code> или <code>площадь трапеции</code>.</div>
          </section>

          <section class="control-block">
            <label class="toggle">
              <input id="previewToggle" type="checkbox" checked>
              <span>Показывать встроенные иллюстрации из PDF</span>
            </label>
          </section>

          <section class="control-block">
            <span class="block-title">Фильтр по заданиям</span>
            <div class="filters">
              ${chipButtons}
            </div>
          </section>

          <section class="control-block">
            <span class="block-title">Быстрый переход</span>
            <nav class="jump-list">
              ${jumpLinks}
            </nav>
          </section>

          <div class="status-line" id="statusLine">Показано тем: ${totalTopics}.</div>
        </aside>

        <main class="reader">
          ${sectionHtml}
        </main>
      </div>
    </div>

    <script>
      const searchInput = document.getElementById("searchInput");
      const clearSearchButton = document.getElementById("clearSearchButton");
      const previewToggle = document.getElementById("previewToggle");
      const statusLine = document.getElementById("statusLine");
      const filterButtons = Array.from(document.querySelectorAll(".filter-chip"));
      const topicEntries = Array.from(document.querySelectorAll(".topic-entry"));
      const taskSections = Array.from(document.querySelectorAll(".task-section"));
      const jumpLinks = Array.from(document.querySelectorAll(".jump-link"));
      const highlightNodes = Array.from(
        document.querySelectorAll(".topic-entry h3, .topic-text p, .topic-text .formula-line"),
      );

      let activeTask = "all";

      function normalize(value) {
        return value.toLocaleLowerCase("ru-RU");
      }

      function escapeHtml(value) {
        return value
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function escapeRegex(value) {
        return value.replace(/[.*+?^()[\]{}|\\$]/g, "\\$&");
      }

      function getQueryTokens() {
        return normalize(searchInput.value.trim())
          .split(/\\s+/)
          .map((token) => token.trim())
          .filter(Boolean);
      }

      function tokenizeText(value) {
        return normalize(value)
          .split(/[^a-zа-я0-9]+/iu)
          .map((token) => token.trim())
          .filter(Boolean);
      }

      function stemWord(word) {
        const stem = word.replace(
          /(иями|ями|ами|его|ого|ему|ому|ее|ие|ые|ое|ей|ий|ый|ой|ем|им|ым|ом|их|ых|ую|юю|ая|яя|ов|ев|ом|ем|ам|ям|ах|ях|ия|ья|ью|ии|ие|ые|ой|ей|а|я|ы|и|е|о|у|ю|ь)$/u,
          "",
        );
        return stem || word;
      }

      function consonantSkeleton(word) {
        return stemWord(word).replace(/[аеёиоуыэюя]/giu, "");
      }

      function tokenMatchesWord(token, word) {
        if (word.includes(token)) {
          return true;
        }

        const tokenStem = stemWord(token);
        const wordStem = stemWord(word);
        if (!tokenStem || !wordStem) {
          return false;
        }

        if (
          tokenStem.length >= 4 &&
          wordStem.length >= 3 &&
          (wordStem === tokenStem || wordStem.includes(tokenStem) || tokenStem.includes(wordStem))
        ) {
          return true;
        }

        const tokenSkeleton = consonantSkeleton(token);
        const wordSkeleton = consonantSkeleton(word);
        if (!tokenSkeleton || !wordSkeleton) {
          return false;
        }

        if (tokenSkeleton === wordSkeleton) {
          return true;
        }

        if (
          tokenSkeleton.length >= 4 &&
          wordSkeleton.length >= 4 &&
          (wordSkeleton.startsWith(tokenSkeleton) || tokenSkeleton.startsWith(wordSkeleton))
        ) {
          return true;
        }

        return false;
      }

      function tokenMatchesHaystack(haystack, token) {
        if (haystack.includes(token)) {
          return true;
        }

        const hayWords = tokenizeText(haystack);
        return hayWords.some((word) => tokenMatchesWord(token, word));
      }

      function buildHighlightHtml(text, tokens) {
        if (!tokens.length) {
          return escapeHtml(text);
        }

        const regex = new RegExp("(" + tokens.map(escapeRegex).join("|") + ")", "giu");
        const segments = text.split(regex);
        let matched = false;
        const html = segments
          .map((segment, index) => {
            const escaped = escapeHtml(segment);
            if (index % 2 === 1) {
              matched = true;
              return '<mark class="search-hit">' + escaped + "</mark>";
            }

            return escaped;
          })
          .join("");

        return { html, matched };
      }

      function updateHighlights(tokens) {
        for (const node of highlightNodes) {
          const text = node.textContent || "";
          if (!tokens.length) {
            node.innerHTML = escapeHtml(text);
            continue;
          }

          const insideHiddenTopic = !!node.closest(".topic-entry[hidden]");
          if (insideHiddenTopic) {
            node.innerHTML = escapeHtml(text);
            continue;
          }

          const result = buildHighlightHtml(text, tokens);
          node.innerHTML = result.matched ? result.html : escapeHtml(text);
        }
      }

      function updateFilters() {
        const tokens = getQueryTokens();
        document.body.dataset.previews = previewToggle.checked ? "on" : "off";
        clearSearchButton.hidden = tokens.length === 0;

        let visibleTopics = 0;
        for (const topic of topicEntries) {
          const matchesTask = activeTask === "all" || topic.dataset.task === activeTask;
          const haystack = normalize(topic.dataset.search);
          const matchesQuery = tokens.length === 0 || tokens.every((token) => tokenMatchesHaystack(haystack, token));
          const isVisible = matchesTask && matchesQuery;
          topic.hidden = !isVisible;
          topic.classList.toggle("search-match", tokens.length > 0 && isVisible);
          if (isVisible) {
            visibleTopics += 1;
          }
        }

        for (const section of taskSections) {
          section.hidden = !section.querySelector(".topic-entry:not([hidden])");
        }

        for (const link of jumpLinks) {
          const target = document.getElementById(link.getAttribute("href").slice(1));
          link.hidden = !target || target.hidden;
        }

        updateHighlights(tokens);

        const activeLabel = activeTask === "all" ? "все задания" : activeTask;
        statusLine.textContent = visibleTopics
          ? \`Показано тем: \${visibleTopics} · фильтр: \${activeLabel}\${tokens.length ? \` · поиск: \${tokens.join(", ")}\` : ""}.\`
          : "Ничего не найдено. Попробуй другое слово или сбрось фильтр.";
      }

      for (const button of filterButtons) {
        button.addEventListener("click", () => {
          activeTask = button.dataset.task;
          for (const current of filterButtons) {
            current.classList.toggle("active", current === button);
          }
          updateFilters();

          if (button.dataset.task !== "all" && !searchInput.value.trim()) {
            const targetLink = document.querySelector(\`.jump-link[data-task-link="\${CSS.escape(button.dataset.task)}"]\`);
            targetLink?.click();
          }
        });
      }

      searchInput.addEventListener("input", updateFilters);
      searchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          const firstVisibleTopic = document.querySelector(".topic-entry.search-match:not([hidden])");
          firstVisibleTopic?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
      clearSearchButton.addEventListener("click", () => {
        searchInput.value = "";
        searchInput.focus();
        updateFilters();
      });
      previewToggle.addEventListener("change", updateFilters);
      updateFilters();
    </script>
  </body>
</html>`;
}

async function renderPreview(pdfDocument, pageNumber, outputPath) {
  const page = await pdfDocument.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = PREVIEW_WIDTH / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const canvasFactory = new NodeCanvasFactory();
  const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);

  await page.render({
    canvasContext: canvasAndContext.context,
    viewport,
    canvasFactory,
  }).promise;

  const pngBuffer = canvasAndContext.canvas.toBuffer("image/png");
  const renderedWidth = canvasAndContext.canvas.width;
  const renderedHeight = canvasAndContext.canvas.height;
  const leftCrop = Math.max(0, Math.round(renderedWidth * PREVIEW_CROP_RATIOS.left));
  const rightCrop = Math.max(0, Math.round(renderedWidth * PREVIEW_CROP_RATIOS.right));
  const topCrop = Math.max(0, Math.round(renderedHeight * PREVIEW_CROP_RATIOS.top));
  const bottomCrop = Math.max(0, Math.round(renderedHeight * PREVIEW_CROP_RATIOS.bottom));
  const width = Math.max(1, renderedWidth - leftCrop - rightCrop);
  const height = Math.max(1, renderedHeight - topCrop - bottomCrop);

  await sharp(pngBuffer)
    .extract({
      left: leftCrop,
      top: topCrop,
      width,
      height,
    })
    .webp({ quality: 80 })
    .toFile(outputPath);
}

async function main() {
  const baseDir = __dirname;
  const sourcePdfPath = process.argv[2] ? path.resolve(process.argv[2]) : findSourcePdf(baseDir);
  if (!sourcePdfPath || !fs.existsSync(sourcePdfPath)) {
    throw new Error("Не удалось найти PDF для конвертации.");
  }

  const pdfjs = await import(PDFJS_MODULE_URL);
  const pdfData = new Uint8Array(fs.readFileSync(sourcePdfPath));
  const pdfDocument = await pdfjs.getDocument({ data: pdfData, disableWorker: true }).promise;

  const outputHtmlPath = path.join(baseDir, OUTPUT_HTML_NAME);
  const outputAssetsDir = path.join(baseDir, OUTPUT_ASSETS_DIR_NAME);
  fs.mkdirSync(outputAssetsDir, { recursive: true });

  const topics = [];
  let currentTaskLabel = null;
  let currentTopic = null;

  for (let pageNumber = FIRST_CONTENT_PAGE; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const lines = extractLines(textContent.items);

    if (isPromotionalPage(lines)) {
      console.log(`Остановлено на рекламном блоке: страница ${pageNumber}`);
      break;
    }

    const record = buildPageRecord(pageNumber, lines, currentTaskLabel);
    currentTaskLabel = record.taskLabel;

    const previewPath = path.join(outputAssetsDir, `page-${String(pageNumber).padStart(3, "0")}.webp`);
    await renderPreview(pdfDocument, pageNumber, previewPath);

    const shouldStartNewTopic =
      !currentTopic ||
      currentTopic.taskLabel !== record.taskLabel ||
      (!record.isContinuation && record.title);

    if (shouldStartNewTopic) {
      if (currentTopic) {
        topics.push(currentTopic);
      }

      currentTopic = {
        taskLabel: record.taskLabel,
        title: record.title || `Материал со страницы ${pageNumber}`,
        pages: [pageNumber],
        blocks: [...record.blocks],
      };
    } else {
      currentTopic.pages.push(pageNumber);
      currentTopic.blocks.push(...record.blocks);
    }

    if (pageNumber % 10 === 0 || pageNumber === pdfDocument.numPages) {
      console.log(`Обработано страниц: ${pageNumber}/${pdfDocument.numPages}`);
    }
  }

  if (currentTopic) {
    topics.push(currentTopic);
  }

  for (const topic of topics) {
    topic.description = buildTopicDescription(topic);
    topic.pageRange = buildTopicRange(topic.pages);
    topic.summary = buildSummary(topic.blocks);
    topic.searchIndex = `${topic.taskLabel} ${topic.title} ${topic.description || ""} ${topic.summary} ${topic.blocks
      .map((block) => block.text)
      .join(" ")}`;
  }

  const topicsByTask = new Map();
  for (const topic of topics) {
    if (!topicsByTask.has(topic.taskLabel)) {
      topicsByTask.set(topic.taskLabel, []);
    }

    topicsByTask.get(topic.taskLabel).push(topic);
  }

  const html = buildHtml({
    topicsByTask,
    sourcePdfName: path.basename(sourcePdfPath),
    totalTopics: topics.length,
    totalPages: topics.reduce((sum, topic) => sum + topic.pages.length, 0),
  });

  fs.writeFileSync(outputHtmlPath, html, "utf8");
  console.log(`Готово: ${outputHtmlPath}`);
}

module.exports = {
  adaptLineText,
  buildPageRecord,
  detectTitle,
  deriveSentenceTitle,
  extractDefinitionTitle,
  extractLines,
  findSourcePdf,
  isContinuationTitle,
  isNoiseLine,
  normalizeTaskLabel,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
