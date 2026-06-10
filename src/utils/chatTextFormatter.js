// ============================================
// 채팅 텍스트 포매터 (리마인드 뷰어용)
// CHATNOVEL 뷰어의 렌더 파이프라인 포팅 (iframe 제외 경량판):
//   raw → 매크로 → ST 정규식 → 이전정보 언랩 → 커서마커 제거
//       → 이미지({{img::}}, extra.media) → 선택지 카드
//       → 마크다운(라인 파서 + HTML 블록 보호) → 대사 하이라이트 → sanitize
//
// ⚠️ 정규식 적용 시 주의:
// String.replace에 치환 문자열을 그대로 넘기면 $& 등 네이티브 해석 때문에
// ST와 다른 결과가 나온다. ST의 runRegexScript처럼
// "함수 콜백 + $N/$<name> 수동 해석 + trimStrings + 매크로 순서"를 재현해야 함.
// ============================================

import { escapeHtml } from './textUtils.js';

// ============================================
// ST 정규식 스크립트 수집/적용
// ============================================

/**
 * 스크립트의 substituteRegex 값 → RegExp 플래그
 */
function getScriptFlags(script) {
    switch (script?.substituteRegex) {
        case 1: return 'g';
        case 2: return 'i';
        case 3: return '';
        default: return 'gi';
    }
}

/**
 * "/pattern/flags" 또는 일반 패턴 문자열 → RegExp
 */
function regexFromString(regexStr, script) {
    if (!regexStr) return null;
    const slashForm = regexStr.match(/^\/(.*?)\/([gimsuy]*)$/);
    try {
        if (slashForm) return new RegExp(slashForm[1], slashForm[2]);
        return new RegExp(regexStr, getScriptFlags(script));
    } catch (e) {
        console.warn('[ChatFormatter] Invalid regex:', regexStr, e.message);
        return null;
    }
}

/**
 * ST에 등록된 정규식 스크립트 수집 (전역 + 캐릭터 내장)
 */
function collectRegexScripts(context, charAvatar) {
    const scripts = [];
    const ext = context?.extensionSettings || {};

    // 전역 스크립트 (버전에 따라 저장 경로가 다름)
    if (Array.isArray(ext.regex)) scripts.push(...ext.regex);
    else if (Array.isArray(ext.regex?.scripts)) scripts.push(...ext.regex.scripts);
    if (Array.isArray(ext.regex_scripts)) scripts.push(...ext.regex_scripts);

    // 캐릭터 카드 내장 스크립트
    try {
        const char = (context?.characters || []).find(c => c.avatar === charAvatar);
        const embedded = char?.data?.extensions?.regex_scripts;
        if (Array.isArray(embedded)) scripts.push(...embedded);
    } catch (e) { /* ignore */ }

    return scripts;
}

/**
 * 단일 정규식 스크립트 적용 (ST runRegexScript 동작 재현)
 */
function applyRegexScript(script, text, options) {
    if (!script?.findRegex || !text) return text;

    const findRegex = regexFromString(script.findRegex, script);
    if (!findRegex) return text;

    // {{match}} → $0 (ST 전처리와 동일)
    const replaceTemplate = (script.replaceString || '').replace(/\{\{match\}\}/gi, '$0');

    const trimStrings = Array.isArray(script.trimStrings)
        ? script.trimStrings.filter(Boolean)
        : [];

    try {
        // 함수 콜백 → 네이티브 $& 해석 차단, 그룹은 아래에서 수동 해석
        return text.replace(findRegex, function () {
            const args = [...arguments];

            let output = replaceTemplate.replace(/\$(\d+)|\$<([^>]+)>/g, (_, num, groupName) => {
                let groupMatch;
                if (num !== undefined) {
                    groupMatch = args[Number(num)];
                } else if (groupName) {
                    const groups = args[args.length - 1];
                    groupMatch = (groups && typeof groups === 'object') ? groups[groupName] : undefined;
                }
                if (!groupMatch) return '';
                for (const trimStr of trimStrings) {
                    groupMatch = groupMatch.replaceAll(trimStr, '');
                }
                return groupMatch;
            });

            // 그룹 해석 이후 매크로 치환 (ST와 동일 순서)
            if (options.characterName) {
                output = output.replace(/\{\{charkey\}\}/gi, options.characterName);
                output = output.replace(/\{\{char\}\}/gi, options.characterName);
            }
            if (options.userName) {
                output = output.replace(/\{\{user\}\}/gi, options.userName);
            }
            return output;
        });
    } catch (e) {
        console.warn('[ChatFormatter] Regex script failed:', script.scriptName, e);
        return text;
    }
}

/**
 * 모든 ST 정규식 스크립트를 메시지에 적용
 */
export function applyStRegexScripts(text, options) {
    if (!text) return text;
    try {
        const context = window.SillyTavern?.getContext?.();
        if (!context) return text;

        const scripts = collectRegexScripts(context, options.charAvatar);
        let result = text;

        for (const script of scripts) {
            if (script.disabled) continue;
            if (script.promptOnly) continue;

            // placement 필터: 2=AI 출력, 1=유저 입력, 0=표시(MD)
            if (Array.isArray(script.placement) && script.placement.length > 0) {
                const forAi = script.placement.includes(2);
                const forUser = script.placement.includes(1);
                const forDisplay = script.placement.includes(0);
                if (options.isUser && !forUser && !forDisplay) continue;
                if (!options.isUser && !forAi && !forDisplay) continue;
            }

            result = applyRegexScript(script, result, options);
        }
        return result;
    } catch (e) {
        console.warn('[ChatFormatter] applyStRegexScripts error:', e);
        return text;
    }
}

// ============================================
// 이미지 처리 ({{img::}} + extra.media)
// ============================================

function escapeAttr(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * 이미지 파일명 → 전체 경로 (ST 캐릭터 이미지 폴더 규칙)
 */
function resolveImagePath(filename, characterName) {
    if (!filename) return '';
    if (filename.startsWith('http://') || filename.startsWith('https://') || filename.startsWith('data:')) {
        return filename;
    }
    if (filename.startsWith('/')) return filename;
    return `/characters/${encodeURIComponent(characterName || 'Unknown')}/${encodeURIComponent(filename)}`;
}

/**
 * 이미지 HTML 생성
 * inline onerror 미사용 (sanitize가 on* 속성을 제거하므로)
 * → 뷰어에서 capture 단계 error 위임으로 폴백 처리
 */
function createImageHtml(src, alt) {
    return `<div class="remind-image-container"><img class="remind-image" src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" title="${escapeAttr(alt)}" loading="lazy" decoding="async"></div>`;
}

/**
 * {{img::파일명}} 패턴 → <img> (정규식 스크립트가 처리 안 한 경우의 폴백)
 */
function processImages(text, characterName) {
    if (!text) return text;
    return text.replace(/\{\{img::([^}]+)\}\}/gi, (match, filename) => {
        const trimmed = filename.trim();
        return createImageHtml(resolveImagePath(trimmed, characterName), trimmed);
    });
}

/**
 * message.extra의 이미지 렌더링 (SD 생성/붙여넣기/auto-pic 등)
 * extra.media[] (현행) / extra.image, extra.image_swipes (구형) 모두 지원
 */
export function renderExtraImagesHtml(message) {
    if (!message?.extra) return '';

    const images = [];
    const extra = Object.assign({}, message.extra);

    if (Array.isArray(extra.media)) {
        for (const media of extra.media) {
            if (media && media.url && (!media.type || media.type === 'image')) {
                images.push({ src: media.url, alt: media.title || '' });
            }
        }
    }

    if (images.length === 0 && extra.image) {
        images.push({ src: extra.image, alt: extra.title || '' });
    }

    if (images.length === 0 && Array.isArray(extra.image_swipes)) {
        const idx = extra.media_index ?? (extra.image_swipes.length - 1);
        const url = extra.image_swipes[idx] || extra.image_swipes[extra.image_swipes.length - 1];
        if (url) images.push({ src: url, alt: extra.title || '' });
    }

    if (images.length === 0) return '';

    return '<div class="remind-extra-images">'
        + images.map(img => createImageHtml(img.src, img.alt)).join('')
        + '</div>';
}

// ============================================
// 텍스트 정리 (이전정보 언랩 / 커서 마커)
// ============================================

/**
 * <details><summary>이전 정보</summary> 래퍼만 제거하고 내용은 유지
 */
function unwrapPreviousInfoBlocks(text) {
    if (!text) return text;

    text = text.replace(/<details[^>]*>\s*<summary[^>]*>[^<]*이전\s*정보[^<]*<\/summary>/gi, '');

    // 언랩으로 고아가 된 </details> 정리
    let openCount = (text.match(/<details\b/gi) || []).length;
    let closeCount = (text.match(/<\/details\s*>/gi) || []).length;
    while (closeCount > openCount) {
        text = text.replace(/<\/details\s*>/, '');
        closeCount--;
    }
    return text;
}

/**
 * 커서 마커 제거 (JS-Slash-Runner 등이 남기는 표시자)
 */
function removeCursorMarkers(text) {
    if (!text) return text;
    text = text.replace(/^\s*\|\s*$/gm, '');
    text = text.replace(/<cursor\s*\/?>/gi, '');
    text = text.replace(/\{\{cursor\}\}/gi, '');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text;
}

// ============================================
// 완전한 HTML 문서 → sandboxed iframe (CHATNOVEL 방식 포팅)
// 상태창 등 정규식이 만든 통짜 HTML/CSS 문서를 실제로 렌더링.
// sandbox="allow-scripts"만 사용 (allow-same-origin 없음 → 부모 접근 불가, 안전)
// 높이는 내부 주입 스크립트가 postMessage로 알려줌
// ============================================

// iframe 내부 주입: 여백 제거 + 스크롤바 숨김
const IFRAME_OVERRIDE_CSS = '<style>html,body{margin:0!important;padding:0!important;background:transparent;}html{scrollbar-width:none!important;}::-webkit-scrollbar{display:none!important;}</style>';

// iframe 내부 주입: shrink-to-measure 높이 측정 → 부모로 postMessage
const IFRAME_RESIZE_SCRIPT = `<script>
(function(){
  document.addEventListener('DOMContentLoaded',function(){
    if(document.getElementById('rm-wrap'))return;
    var w=document.createElement('div');
    w.id='rm-wrap';
    while(document.body.firstChild)w.appendChild(document.body.firstChild);
    document.body.appendChild(w);
    init();
  });
  function init(){
    var w=document.getElementById('rm-wrap');
    if(!w)return;
    var timer=null;
    function sendH(){
      if(timer)return;
      timer=setTimeout(function(){
        timer=null;
        var orig=w.style.height;
        var origOv=w.style.overflow;
        w.style.overflow='auto';
        w.style.height='0';
        var h=w.scrollHeight;
        w.style.height=orig||'';
        w.style.overflow=origOv||'';
        if(h>0){
          window.parent.postMessage({type:'remind-iframe-resize',height:h},'*');
        }
      },0);
    }
    sendH();
    document.querySelectorAll('details').forEach(function(d){
      d.addEventListener('toggle',function(){
        sendH();
        setTimeout(sendH,100);
        setTimeout(sendH,300);
      });
    });
    new MutationObserver(function(){sendH();}).observe(w,{childList:true,subtree:true,attributes:true});
    [100,300,600,1500,3000].forEach(function(d){setTimeout(sendH,d);});
  }
})();
<\/script>`;

/**
 * 완전한 HTML 문서를 placeholder 토큰으로 치환 (마크다운 처리 전)
 * 실제 iframe HTML은 배열에 보관했다가 마크다운 후 복원
 * (코드펜스 안의 OLD 문서는 이미 보호되어 <pre>가 되므로 현재 문서만 변환됨)
 */
function convertHtmlDocsToIframes(text) {
    const iframePlaceholders = [];
    if (!text) return { text, iframePlaceholders };

    // 정규식 스크립트가 HTML을 [...]로 감싸는 경우 대비 - 앞뒤 대괄호 함께 소비
    const htmlDocPattern = /\[?\s*(?:<!DOCTYPE\s+html[^>]*>[\s\S]*?<\/html>|<html[^>]*>[\s\S]*?<\/html>)\s*\]?/gi;

    const processed = text.replace(htmlDocPattern, (match) => {
        let modified = match.replace(/^\s*\[/, '').replace(/\]\s*$/, '');

        // </head> 앞에 override CSS 주입
        if (modified.includes('</head>')) {
            modified = modified.replace('</head>', IFRAME_OVERRIDE_CSS + '</head>');
        } else if (modified.includes('<body')) {
            modified = modified.replace('<body', IFRAME_OVERRIDE_CSS + '<body');
        } else {
            modified = IFRAME_OVERRIDE_CSS + modified;
        }

        // </body> 앞에 높이 통신 스크립트 주입
        if (modified.includes('</body>')) {
            modified = modified.replace('</body>', IFRAME_RESIZE_SCRIPT + '</body>');
        } else {
            modified += IFRAME_RESIZE_SCRIPT;
        }

        // Base64 인코딩 - srcdoc 따옴표 충돌 완전 회피 (뷰어에서 디코딩 후 srcdoc 주입)
        const b64 = btoa(unescape(encodeURIComponent(modified)));

        const iframe = `<iframe class="remind-regex-iframe" data-remind-html="${b64}" sandbox="allow-scripts" frameborder="0" scrolling="no"></iframe>`;
        const index = iframePlaceholders.length;
        iframePlaceholders.push(iframe);
        return `\n%%%RM_IFRAME_${index}%%%\n`;
    });

    return { text: processed, iframePlaceholders };
}

/**
 * 마크다운 처리 후 placeholder → 실제 iframe 복원
 * (마크다운이 토큰을 <p>/<pre> 등으로 감쌌을 수 있어 래퍼까지 함께 소비)
 */
function restoreIframePlaceholders(html, iframePlaceholders) {
    if (!iframePlaceholders || iframePlaceholders.length === 0) return html;
    return html.replace(
        /(?:<br\s*\/?>)?\s*(?:<pre[^>]*>)?\s*(?:<code[^>]*>)?\s*(?:<p[^>]*>)?\s*%%%RM_IFRAME_(\d+)%%%\s*(?:<\/p>)?\s*(?:<\/code>)?\s*(?:<\/pre>)?\s*(?:<br\s*\/?>)?/g,
        (match, index) => iframePlaceholders[parseInt(index, 10)] || match
    );
}

// ============================================
// 선택지 카드
// ============================================

function processChoices(text) {
    if (!text) return text;

    return text.replace(/<choices>([\s\S]*?)<\/choices>/gi, (match, content) => {
        const lines = content.trim().split('\n').filter(l => l.trim());
        if (lines.length === 0) return match;

        let html = '<div class="remind-choices"><div class="remind-choices-header">선택지</div>';
        lines.forEach((line, i) => {
            const cleanLine = line.replace(/^\d+[.)\-]\s*/, '').trim();
            if (cleanLine) {
                html += `<div class="remind-choice-card"><span class="remind-choice-num">${i + 1}.</span><span>${escapeHtml(cleanLine)}</span></div>`;
            }
        });
        html += '</div>';
        return html;
    });
}

// ============================================
// 마크다운 (라인 파서 + HTML 블록 보호)
// ============================================

function processInlineMarkdown(text) {
    if (!text) return '';
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return text;
}

/**
 * 마크다운 → HTML
 * 정규식 스크립트가 만든 멀티라인 HTML 블록(상태창 등)은
 * depth 추적으로 마크다운 처리에서 제외 (CHATNOVEL 방식)
 */
function renderMarkdown(text) {
    if (!text) return '';

    const protectedBlocks = [];
    function protectBlock(match) {
        const idx = protectedBlocks.length;
        protectedBlocks.push(match);
        return `\x00HTMLBLOCK${idx}\x00`;
    }

    // 코드 펜스 먼저 추출 (내용은 escape되어 안전한 <pre>로)
    const codeBlocks = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push(`<pre class="remind-code"><code>${escapeHtml(code.trim())}</code></pre>`);
        return `\x00CODEBLOCK${idx}\x00`;
    });

    const inlineCodes = [];
    text = text.replace(/`([^`]+)`/g, (match, code) => {
        const idx = inlineCodes.length;
        inlineCodes.push(`<code class="remind-inline-code">${escapeHtml(code)}</code>`);
        return `\x00INLINECODE${idx}\x00`;
    });

    // <style>/<svg>/<table> 블록 보호 (script는 sanitize에서 제거됨)
    text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, protectBlock);
    text = text.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, protectBlock);
    text = text.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, protectBlock);

    // 라인 단위 처리 + HTML 블록 depth 추적
    const blockOpenRe = /<(div|details|section|article|aside|nav|header|footer|form|fieldset|figure|main|pre|dl)\b/gi;
    const blockCloseRe = /<\/(div|details|section|article|aside|nav|header|footer|form|fieldset|figure|main|pre|dl)\s*>/gi;
    const countOpens = (str) => (str.match(blockOpenRe) || []).length;
    const countCloses = (str) => (str.match(blockCloseRe) || []).length;

    const lines = text.split('\n');
    const result = [];
    let inList = false;
    let listType = '';
    let htmlBlockDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // HTML 블록 내부: 마크다운 처리 없이 통과
        if (htmlBlockDepth > 0) {
            htmlBlockDepth += countOpens(trimmed) - countCloses(trimmed);
            if (htmlBlockDepth < 0) htmlBlockDepth = 0;
            result.push(line);
            continue;
        }

        // HTML 블록 시작 감지
        if (/^<[a-zA-Z]/.test(trimmed)) {
            const opens = countOpens(trimmed);
            const closes = countCloses(trimmed);
            if (opens > closes) {
                htmlBlockDepth = opens - closes;
            }
            result.push(trimmed);
            continue;
        }

        if (/^<\/[a-zA-Z]/.test(trimmed)) {
            htmlBlockDepth -= countCloses(trimmed);
            if (htmlBlockDepth < 0) htmlBlockDepth = 0;
            result.push(trimmed);
            continue;
        }

        // 리스트 종료
        if (inList && !trimmed.match(/^[-*]\s/) && !trimmed.match(/^\d+\.\s/)) {
            result.push(listType === 'ul' ? '</ul>' : '</ol>');
            inList = false;
        }

        if (!trimmed) {
            result.push('<br />');
            continue;
        }

        // 헤딩
        const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            result.push(`<h${level} class="remind-h">${processInlineMarkdown(headingMatch[2])}</h${level}>`);
            continue;
        }

        // 수평선
        if (/^[-*_]{3,}\s*$/.test(trimmed)) {
            result.push('<hr class="remind-hr" />');
            continue;
        }

        // 인용
        if (trimmed.startsWith('>')) {
            result.push(`<blockquote class="remind-quote">${processInlineMarkdown(trimmed.replace(/^>\s?/, ''))}</blockquote>`);
            continue;
        }

        // 비순서 리스트
        const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
        if (ulMatch) {
            if (!inList || listType !== 'ul') {
                if (inList) result.push(listType === 'ul' ? '</ul>' : '</ol>');
                result.push('<ul class="remind-list-md">');
                inList = true;
                listType = 'ul';
            }
            result.push(`<li>${processInlineMarkdown(ulMatch[1])}</li>`);
            continue;
        }

        // 순서 리스트
        const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
        if (olMatch) {
            if (!inList || listType !== 'ol') {
                if (inList) result.push(listType === 'ul' ? '</ul>' : '</ol>');
                result.push('<ol class="remind-list-md">');
                inList = true;
                listType = 'ol';
            }
            result.push(`<li>${processInlineMarkdown(olMatch[1])}</li>`);
            continue;
        }

        // 보호 블록 플레이스홀더 통과
        if (/^\x00(HTMLBLOCK|CODEBLOCK|INLINECODE)\d+\x00$/.test(trimmed)) {
            result.push(trimmed);
            continue;
        }

        // 일반 단락
        result.push(`<p class="remind-p">${processInlineMarkdown(trimmed)}</p>`);
    }

    if (inList) {
        result.push(listType === 'ul' ? '</ul>' : '</ol>');
    }

    text = result.join('\n');

    // 복원 (함수 콜백으로 $ 특수문자 해석 차단)
    codeBlocks.forEach((block, i) => {
        text = text.replace(`\x00CODEBLOCK${i}\x00`, () => block);
    });
    inlineCodes.forEach((code, i) => {
        text = text.replace(`\x00INLINECODE${i}\x00`, () => code);
    });
    protectedBlocks.forEach((block, i) => {
        text = text.replace(`\x00HTMLBLOCK${i}\x00`, () => block);
    });

    return text;
}

// ============================================
// 대사 하이라이트
// ============================================

function styleDialogue(html) {
    if (!html) return html;
    // 텍스트 노드 구간에서만 "..."를 감싸기 (태그 내부 속성 오염 방지)
    html = html.replace(/(?<=>|^)([^<]*?"[^"]*?"[^<]*?)(?=<|$)/g, (match) => {
        return match.replace(/"([^"]+)"/g, '<span class="remind-dialogue">"$1"</span>');
    });
    html = html.replace(/(?<=>|^)([^<]*?「[^」]*?」[^<]*?)(?=<|$)/g, (match) => {
        return match.replace(/「([^」]+)」/g, '<span class="remind-dialogue">「$1」</span>');
    });
    return html;
}

// ============================================
// sanitize - 실행 가능 요소만 제거 (장식 HTML/스타일은 유지)
// ============================================

function sanitizeHtml(html) {
    const doc = document.implementation.createHTMLDocument('');
    const root = doc.createElement('div');
    root.innerHTML = html;

    root.querySelectorAll('script, object, embed, link, meta, base, form').forEach(el => el.remove());

    // iframe은 우리가 만든 sandboxed 정규식 iframe만 허용
    root.querySelectorAll('iframe').forEach(el => {
        if (!el.classList.contains('remind-regex-iframe')) {
            el.remove();
            return;
        }
        // sandbox 강제 + src 차단 (내용은 뷰어에서 data-remind-html → srcdoc로만 주입)
        el.setAttribute('sandbox', 'allow-scripts');
        el.removeAttribute('src');
        el.removeAttribute('srcdoc');
    });

    root.querySelectorAll('*').forEach(el => {
        for (const attr of [...el.attributes]) {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on')) {
                el.removeAttribute(attr.name);
            } else if ((name === 'href' || name === 'src' || name === 'xlink:href')
                && /^\s*javascript:/i.test(attr.value)) {
                el.removeAttribute(attr.name);
            }
        }
    });

    return root.innerHTML;
}

// ============================================
// 공개 API - 메시지 → HTML
// ============================================

/**
 * 메시지 객체를 화면용 HTML로 변환 (CHATNOVEL renderMessage 흐름)
 * @param {Object} message - ST 메시지 객체 (mes, is_user, extra, swipes...)
 * @param {{ characterName: string, userName: string, charAvatar: string, applyRegex?: boolean }} options
 * @returns {string} 안전한 HTML
 */
export function renderMessageHtml(message, options) {
    // 스와이프 반영
    let text = message.mes || '';
    if (Array.isArray(message.swipes) && typeof message.swipe_id === 'number'
        && message.swipes[message.swipe_id] !== undefined) {
        text = message.swipes[message.swipe_id];
    }
    if (!text && !message.extra) return '';

    // 1. 매크로 치환
    if (options.userName) text = text.replace(/\{\{user\}\}/gi, options.userName);
    if (options.characterName) text = text.replace(/\{\{char\}\}/gi, options.characterName);

    // 2. ST 정규식 스크립트 (이미지 변환/커스텀 태그/상태창 등) - 토글 가능
    if (options.applyRegex !== false) {
        text = applyStRegexScripts(text, {
            isUser: !!message.is_user,
            characterName: options.characterName,
            userName: options.userName,
            charAvatar: options.charAvatar,
        });
    }

    // 3. "이전 정보" details 언랩 + 커서 마커 제거
    text = unwrapPreviousInfoBlocks(text);
    text = removeCursorMarkers(text);

    // 4. 완전한 HTML 문서 → sandboxed iframe placeholder (마크다운 전)
    const { text: textWithPlaceholders, iframePlaceholders } = convertHtmlDocsToIframes(text);
    text = textWithPlaceholders;

    // 5. {{img::}} 이미지 폴백 처리
    text = processImages(text, options.characterName);

    // 6. 선택지 카드
    text = processChoices(text);

    // 7. 마크다운
    text = renderMarkdown(text);

    // 7.5. placeholder → 실제 iframe 복원 (마크다운 후)
    text = restoreIframePlaceholders(text, iframePlaceholders);

    // 8. 대사 하이라이트
    text = styleDialogue(text);

    // 9. extra 이미지 (SD 생성/붙여넣기 등)
    const extraImgHtml = renderExtraImagesHtml(message);
    if (extraImgHtml) {
        if (message.extra?.inline_image) {
            text = extraImgHtml; // 이미지 자체가 메시지인 경우
        } else {
            text += extraImgHtml;
        }
    }

    // 10. sanitize
    return sanitizeHtml(text);
}
