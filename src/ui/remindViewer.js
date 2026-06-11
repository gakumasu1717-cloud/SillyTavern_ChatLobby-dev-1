// ============================================
// 리마인드 뷰어 (이북 리더)
//
// 구조: 채팅 패널(#chat-lobby-chats)과 동일한 메커니즘
// - 템플릿에 고정 존재하는 호스트 + .visible 클래스 토글
//
// 기능:
// - 페이지네이션 + 범위 연장 (마지막 페이지에서 ▶ = 다음 구간 이어 보기)
// - 이어 읽기 (범위/페이지/스크롤 위치 기억) - 리마인드/일반 감상 모두
// - ▶️ 이어서 채팅하기 / 🔖 뷰어 안에서 구간 저장
// - ⚙️ 설정 팝업 (페이지 크기 / 글자 크기 / 읽기 테마 / 정규식 / 백업)
// - 🖍️ 형광펜 (텍스트 선택 → 저장 → 재방문 시 복원, 탭하면 제거)
// - 채팅 목록에서 "뷰어로 감상" (리마인드 없이 전체 감상)
// ============================================

import { api } from '../api/sillyTavern.js';
import { remindStore } from '../data/remindStore.js';
import { highlightStore } from '../data/highlightStore.js';
import { renderMessageHtml } from '../utils/chatTextFormatter.js';
import { escapeHtml } from '../utils/textUtils.js';
import { showToast, showConfirm, showPrompt } from './notifications.js';
import { listeners } from '../utils/listenerManager.js';
import { uiPrefs } from '../data/uiPrefs.js';
import { openChat } from '../handlers/chatHandlers.js';

let isViewerOpen = false;

// 현재 뷰어 세션 상태
let currentRemind = null;       // 리마인드 객체 또는 임시(adhoc) 감상 객체
let currentMessages = null;
let regexEnabled = true;
let pageIndex = 0;

// 현재 보고 있는 범위 (리마인드 범위에서 시작, 연장 가능)
let viewStart = 0;
let viewEnd = 0;

// 마지막으로 렌더된 페이지의 메시지 범위 (뷰어 내 리마인드 추가 기본값)
let lastRenderedRange = { from: 0, to: 0 };

// 진행 저장 디바운스
let progressSaveTimer = null;

// 형광펜 선택 대기 상태
let pendingHighlight = null;

// 글자 크기 범위
const FONT_MIN = 12;
const FONT_MAX = 24;

// 페이지 크기 옵션 (0 = 모두)
const PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 0];

// 읽기 테마 옵션
const READER_THEMES = [
    { id: 'auto',  name: '🎨 로비 테마' },
    { id: 'dark',  name: '🌙 다크' },
    { id: 'sepia', name: '📜 세피아' },
    { id: 'paper', name: '🤍 순백' },
];

/**
 * 리마인드로 뷰어 열기
 * @param {string} remindId
 */
export async function openRemindViewer(remindId) {
    const remind = remindStore.get(remindId);
    if (!remind) {
        showToast('리마인드를 찾을 수 없습니다.', 'error');
        return;
    }
    await openViewerWithData(remind);
}

/**
 * 리마인드 없이 채팅 전체를 뷰어로 감상 (채팅 목록 ⋮ 메뉴에서)
 * 진행 위치는 채팅별 임시 ID로 저장되어 이어 읽기도 동작
 * @param {string} avatar
 * @param {string} charName
 * @param {string} fileName
 */
export async function openChatInViewer(avatar, charName, fileName) {
    const cleanName = (fileName || '').replace(/\.jsonl$/i, '');
    await openViewerWithData({
        id: `adhoc_${avatar}::${cleanName}`, // 진행 저장용 안정 키
        avatar,
        charName: charName || avatar.replace(/\.[^.]+$/, ''),
        fileName: cleanName,
        start: null,
        end: null,
        note: '',
        _adhoc: true,
    });
}

/**
 * 뷰어 열기 (공통)
 * @param {Object} remind - 리마인드 또는 임시 감상 객체
 */
async function openViewerWithData(remind) {
    closeRemindViewer(); // 기존 뷰어 정리

    const overlay = document.getElementById('chat-lobby-remind-viewer');
    if (!overlay) {
        showToast('뷰어를 열 수 없습니다. 로비를 다시 열어주세요.', 'error');
        return;
    }

    currentRemind = remind;
    currentMessages = null;
    regexEnabled = true;
    pageIndex = 0;
    pendingHighlight = null;

    const rangeText = remind._adhoc
        ? '전체 감상'
        : (remind.start !== null || remind.end !== null)
            ? `#${remind.start ?? 0} ~ ${remind.end !== null ? '#' + remind.end : '끝'}`
            : '전체';

    const pageSize = getPageSize();
    const fontSize = getFontSize();
    const readerTheme = getReaderTheme();

    overlay.innerHTML = `
        <div class="remind-viewer-panel" data-reader-theme="${readerTheme}">
            <header class="remind-viewer-header" id="remind-viewer-header">
                <div class="remind-viewer-toprow">
                    <div class="remind-viewer-title">
                        <span class="remind-viewer-char">${escapeHtml(remind.charName || '')}</span>
                        <span class="remind-viewer-file">${escapeHtml(remind.fileName)} · ${escapeHtml(rangeText)}</span>
                        ${remind.note ? `<span class="remind-viewer-note">🔖 ${escapeHtml(remind.note)}</span>` : ''}
                    </div>
                    <div class="remind-viewer-topbtns">
                        <button class="remind-viewer-btn" id="remind-continue-chat" title="이 채팅 이어서 하기">▶️ 이어 채팅</button>
                        <button class="remind-viewer-btn" id="remind-add-here" title="현재 보는 구간을 리마인드로 저장">🔖</button>
                        <button class="remind-viewer-btn" id="remind-settings-toggle" title="뷰어 설정">⚙️</button>
                        <button class="remind-viewer-close" title="닫기">✕</button>
                    </div>
                </div>
                <div class="remind-viewer-pagrow">
                    <button class="remind-viewer-btn" id="remind-page-prev" title="이전 페이지 (범위 앞도 이어서 불러옴)">◀</button>
                    <span class="remind-page-label" id="remind-page-label">-</span>
                    <button class="remind-viewer-btn" id="remind-page-next" title="다음 페이지 (범위 끝나면 이어서 불러옴)">▶</button>
                </div>
                <div class="remind-settings-pop" id="remind-settings-pop" style="display:none;">
                    <div class="remind-set-row">
                        <span class="remind-set-label">페이지당</span>
                        <select class="remind-viewer-select" id="remind-page-size">
                            ${PAGE_SIZE_OPTIONS.map(n => `
                                <option value="${n}" ${n === pageSize ? 'selected' : ''}>${n === 0 ? '모두' : n + '개씩'}</option>
                            `).join('')}
                        </select>
                    </div>
                    <div class="remind-set-row">
                        <span class="remind-set-label">글자 크기</span>
                        <div class="remind-set-inline">
                            <button class="remind-viewer-btn" id="remind-font-minus">A−</button>
                            <span class="remind-page-label" id="remind-font-label">${fontSize}px</span>
                            <button class="remind-viewer-btn" id="remind-font-plus">A＋</button>
                        </div>
                    </div>
                    <div class="remind-set-row">
                        <span class="remind-set-label">읽기 테마</span>
                        <select class="remind-viewer-select" id="remind-theme-select">
                            ${READER_THEMES.map(t => `
                                <option value="${t.id}" ${t.id === readerTheme ? 'selected' : ''}>${t.name}</option>
                            `).join('')}
                        </select>
                    </div>
                    <div class="remind-set-row remind-set-actions">
                        <button class="remind-viewer-btn" id="remind-viewer-regex" title="ST 정규식 스크립트 적용 켜기/끄기">✨ 정규식 ON</button>
                        <button class="remind-viewer-btn" id="remind-viewer-export" title="이 구간 전체를 텍스트 파일로 백업">💾 백업</button>
                    </div>
                </div>
            </header>
            <div class="remind-viewer-body">
                <div class="remind-viewer-loading">📖 채팅을 불러오는 중...</div>
            </div>
            <button class="remind-hl-popup" id="remind-hl-popup" style="display:none;">🖍️ 형광펜</button>
            <div class="remind-lightbox" id="remind-lightbox">
                <div class="remind-lightbox-backdrop"></div>
                <div class="remind-lightbox-content">
                    <img class="remind-lightbox-img" src="" alt="">
                    <div class="remind-lightbox-caption"></div>
                    <button class="remind-lightbox-close" title="닫기">✕</button>
                </div>
            </div>
        </div>
    `;

    overlay.classList.add('visible');
    isViewerOpen = true;

    applyFontSize(fontSize);

    // ===== 이벤트 바인딩 =====
    listeners.add('remindViewer', overlay.querySelector('.remind-viewer-close'), 'click', closeRemindViewer);
    listeners.add('remindViewer', overlay.querySelector('#remind-viewer-regex'), 'click', toggleRegex);
    listeners.add('remindViewer', overlay.querySelector('#remind-viewer-export'), 'click', exportCurrentRange);
    listeners.add('remindViewer', overlay.querySelector('#remind-continue-chat'), 'click', continueChat);
    listeners.add('remindViewer', overlay.querySelector('#remind-add-here'), 'click', addRemindFromViewer);

    // 설정 팝업 토글
    listeners.add('remindViewer', overlay.querySelector('#remind-settings-toggle'), 'click', (e) => {
        e.stopPropagation();
        toggleSettingsPop();
    });

    // 페이지네이션 (+범위 연장)
    listeners.add('remindViewer', overlay.querySelector('#remind-page-prev'), 'click', () => changePage(-1));
    listeners.add('remindViewer', overlay.querySelector('#remind-page-next'), 'click', () => changePage(1));
    listeners.add('remindViewer', overlay.querySelector('#remind-page-size'), 'change', (e) => {
        uiPrefs.set('viewerPageSize', parseInt(e.target.value, 10) || 0);
        pageIndex = 0;
        renderMessages();
    });

    // 글자 크기
    listeners.add('remindViewer', overlay.querySelector('#remind-font-minus'), 'click', () => changeFontSize(-1));
    listeners.add('remindViewer', overlay.querySelector('#remind-font-plus'), 'click', () => changeFontSize(1));

    // 읽기 테마
    listeners.add('remindViewer', overlay.querySelector('#remind-theme-select'), 'change', (e) => {
        uiPrefs.set('viewerTheme', e.target.value);
        const panel = overlay.querySelector('.remind-viewer-panel');
        if (panel) panel.dataset.readerTheme = e.target.value;
    });

    // 패널 밖(어두운 영역) 클릭 시 닫기
    listeners.add('remindViewer', overlay, 'click', (e) => {
        if (e.target === overlay) closeRemindViewer();
    });
    listeners.add('remindViewer', document, 'keydown', handleViewerKeydown);

    const viewerBody = overlay.querySelector('.remind-viewer-body');

    // 자동 숨김 플로팅 헤더 + 진행 위치 저장
    let lastScrollTop = 0;
    listeners.add('remindViewer', viewerBody, 'scroll', () => {
        const header = document.getElementById('remind-viewer-header');
        if (header) {
            const st = viewerBody.scrollTop;
            if (st < 40) {
                header.classList.remove('header-hidden');
            } else if (st > lastScrollTop + 6) {
                header.classList.add('header-hidden');
                hideSettingsPop();
            } else if (st < lastScrollTop - 6) {
                header.classList.remove('header-hidden');
            }
            lastScrollTop = st;
        }
        scheduleProgressSave();
        hideHighlightPopup();
    }, { passive: true });

    // 본문 클릭: 설정 팝업 닫기 → 형광펜 제거 → 이미지 라이트박스
    listeners.add('remindViewer', viewerBody, 'click', async (e) => {
        hideSettingsPop();

        const mark = e.target.closest('.remind-highlight');
        if (mark) {
            e.preventDefault();
            e.stopPropagation();
            const hlId = mark.dataset.hlId;
            const confirmed = await showConfirm('이 형광펜을 지울까요?');
            if (confirmed && hlId) {
                highlightStore.remove(hlId);
                unwrapHighlight(hlId);
            }
            return;
        }

        const img = e.target.closest('img');
        if (img) {
            e.preventDefault();
            e.stopPropagation();
            openLightbox(img.src, img.alt || img.title || '');
        }
    });

    // 형광펜: 텍스트 선택 감지 (PC mouseup + 모바일 길게 눌러 선택 후 touchend)
    listeners.add('remindViewer', viewerBody, 'mouseup', () => setTimeout(handleTextSelection, 10));
    listeners.add('remindViewer', viewerBody, 'touchend', () => setTimeout(handleTextSelection, 200));
    listeners.add('remindViewer', overlay.querySelector('#remind-hl-popup'), 'click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        saveHighlightFromSelection();
    });

    // 라이트박스
    listeners.add('remindViewer', overlay.querySelector('.remind-lightbox-backdrop'), 'click', closeLightbox);
    listeners.add('remindViewer', overlay.querySelector('.remind-lightbox-close'), 'click', closeLightbox);

    // 이미지 로드 실패 폴백
    listeners.add('remindViewer', viewerBody, 'error', (e) => {
        const img = e.target;
        if (img?.tagName === 'IMG' && img.closest('.remind-image-container')) {
            img.closest('.remind-image-container').innerHTML =
                `<div class="remind-image-fallback">🖼️ ${escapeHtml(img.alt || '이미지를 찾을 수 없음')}</div>`;
        }
    }, true);

    // 정규식 iframe 높이 통신
    listeners.add('remindViewer', window, 'message', (e) => {
        if (e.data?.type !== 'remind-iframe-resize' || typeof e.data.height !== 'number') return;
        const iframes = document.querySelectorAll('#chat-lobby-remind-viewer iframe.remind-regex-iframe');
        for (const frame of iframes) {
            if (frame.contentWindow === e.source) {
                const h = Math.ceil(e.data.height);
                frame.style.height = (h > 20 ? h : 400) + 'px';
                break;
            }
        }
    });

    // ===== 데이터 로드 + 렌더 =====
    const body = overlay.querySelector('.remind-viewer-body');
    try {
        const messages = await api.getChatMessages(remind.avatar, remind.fileName);
        if (!messages || messages.length === 0) {
            body.innerHTML = '<div class="remind-viewer-loading">⚠️ 채팅을 불러오지 못했습니다. (파일이 삭제되었거나 이름이 바뀌었을 수 있어요)</div>';
            return;
        }
        currentMessages = messages;

        // 보기 범위 초기화 (+ 채팅 길이를 벗어난 저장값 자동 보정)
        const total = messages.length;
        viewStart = Math.max(0, remind.start ?? 0);
        viewEnd = Math.min(total - 1, remind.end ?? total - 1);

        const progress = remindStore.getProgress(remind.id);
        if (progress) {
            viewStart = Math.max(0, progress.viewStart ?? viewStart);
            viewEnd = Math.max(viewStart, progress.viewEnd ?? viewEnd);
            pageIndex = Math.max(0, progress.pageIndex ?? 0);
        }

        // ★ 범위가 채팅 길이를 통째로 벗어나면 (괴상한 숫자 입력 등) 끝 구간으로 보정
        if (viewStart > total - 1) {
            viewStart = Math.max(0, total - (getPageSize() || 20));
            viewEnd = total - 1;
            pageIndex = 0;
            showToast(`범위가 채팅 길이(${total}개)를 벗어나 끝 구간으로 이동했어요.`, 'warning');
        }
        viewEnd = Math.min(total - 1, viewEnd);

        renderMessages();

        // 스크롤 위치 복원
        if (progress?.scrollTop > 0) {
            body.scrollTop = progress.scrollTop;
        }
    } catch (e) {
        console.error('[RemindViewer] Load failed:', e);
        body.innerHTML = '<div class="remind-viewer-loading">⚠️ 채팅 로딩 중 오류가 발생했습니다.</div>';
    }
}

/**
 * 뷰어 닫기
 */
export function closeRemindViewer() {
    if (isViewerOpen) saveProgressNow();

    const overlay = document.getElementById('chat-lobby-remind-viewer');
    if (overlay) {
        overlay.classList.remove('visible');
        overlay.innerHTML = '';
    }
    if (progressSaveTimer) {
        clearTimeout(progressSaveTimer);
        progressSaveTimer = null;
    }
    listeners.clear('remindViewer');
    isViewerOpen = false;
    currentRemind = null;
    currentMessages = null;
    pendingHighlight = null;
}

/**
 * ESC 처리용: 최상위 레이어(라이트박스 → 설정팝업 → 뷰어) 하나만 닫기
 * @returns {boolean} 닫은 게 있으면 true
 */
export function closeTopRemindLayer() {
    if (!isViewerOpen) return false;

    const lb = document.getElementById('remind-lightbox');
    if (lb?.classList.contains('active')) {
        closeLightbox();
        return true;
    }
    const pop = document.getElementById('remind-settings-pop');
    if (pop && pop.style.display !== 'none') {
        hideSettingsPop();
        return true;
    }
    closeRemindViewer();
    return true;
}

export function isRemindViewerOpen() {
    return isViewerOpen;
}

function handleViewerKeydown(e) {
    if (!isViewerOpen) return;

    if (e.key === 'Escape') {
        e.stopPropagation();
        closeTopRemindLayer();
        return;
    }

    if (e.key === 'ArrowLeft') {
        changePage(-1);
    } else if (e.key === 'ArrowRight') {
        changePage(1);
    }
}

// ============================================
// 설정 팝업
// ============================================

function toggleSettingsPop() {
    const pop = document.getElementById('remind-settings-pop');
    if (!pop) return;
    pop.style.display = pop.style.display === 'none' ? 'block' : 'none';
}

function hideSettingsPop() {
    const pop = document.getElementById('remind-settings-pop');
    if (pop) pop.style.display = 'none';
}

// ============================================
// 설정 (글자 / 페이지 / 테마)
// ============================================

function getFontSize() {
    const v = parseInt(uiPrefs.get('viewerFontSize'), 10);
    return Math.min(FONT_MAX, Math.max(FONT_MIN, isNaN(v) ? 15 : v));
}

function getPageSize() {
    const v = parseInt(uiPrefs.get('viewerPageSize'), 10);
    return PAGE_SIZE_OPTIONS.includes(v) ? v : 10;
}

function getReaderTheme() {
    const v = uiPrefs.get('viewerTheme');
    return READER_THEMES.some(t => t.id === v) ? v : 'auto';
}

function applyFontSize(px) {
    const panel = document.querySelector('#chat-lobby-remind-viewer .remind-viewer-panel');
    if (panel) panel.style.setProperty('--remind-font', `${px}px`);
    const label = document.getElementById('remind-font-label');
    if (label) label.textContent = `${px}px`;
}

function changeFontSize(delta) {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, getFontSize() + delta));
    uiPrefs.set('viewerFontSize', next);
    applyFontSize(next);
}

function toggleRegex() {
    regexEnabled = !regexEnabled;
    const btn = document.getElementById('remind-viewer-regex');
    if (btn) {
        btn.textContent = regexEnabled ? '✨ 정규식 ON' : '✨ 정규식 OFF';
        btn.classList.toggle('off', !regexEnabled);
    }
    renderMessages(true);
}

// ============================================
// 이어 읽기 (진행 위치 저장)
// ============================================

function scheduleProgressSave() {
    if (progressSaveTimer) clearTimeout(progressSaveTimer);
    progressSaveTimer = setTimeout(saveProgressNow, 600);
}

function saveProgressNow() {
    if (!currentRemind) return;
    const body = document.querySelector('#chat-lobby-remind-viewer .remind-viewer-body');
    remindStore.setProgress(currentRemind.id, {
        viewStart,
        viewEnd,
        pageIndex,
        scrollTop: body ? Math.round(body.scrollTop) : 0,
    });
}

// ============================================
// 데이터 슬라이스 / 페이지네이션 / 범위 연장
// ============================================

function getCurrentSlice() {
    if (!currentRemind || !currentMessages) return null;
    return {
        slice: currentMessages.slice(viewStart, viewEnd + 1),
        start: viewStart,
    };
}

function getTotalPages(rangeLength) {
    const pageSize = getPageSize();
    if (pageSize === 0) return 1;
    return Math.max(1, Math.ceil(rangeLength / pageSize));
}

/**
 * 페이지 이동 + 범위 연장 (이어서 보기)
 */
function changePage(delta) {
    const data = getCurrentSlice();
    if (!data || !currentMessages) return;

    const total = currentMessages.length;
    const pageSize = getPageSize();
    const extendChunk = pageSize || 20;
    const totalPages = getTotalPages(data.slice.length);

    if (delta > 0) {
        if (pageIndex < totalPages - 1) {
            pageIndex++;
        } else if (viewEnd < total - 1) {
            const newEnd = Math.min(total - 1, viewEnd + extendChunk);
            viewEnd = newEnd;
            pageIndex++;
            showToast(`📖 다음 구간 이어 보기 (~#${newEnd})`, 'info', 1500);
        } else {
            return;
        }
    } else {
        if (pageIndex > 0) {
            pageIndex--;
        } else if (viewStart > 0) {
            const newStart = Math.max(0, viewStart - extendChunk);
            viewStart = newStart;
            pageIndex = 0;
            showToast(`📖 이전 구간 이어 보기 (#${newStart}~)`, 'info', 1500);
        } else {
            return;
        }
    }

    renderMessages();
    scheduleProgressSave();
}

function resolveMes(msg) {
    if (Array.isArray(msg.swipes) && typeof msg.swipe_id === 'number'
        && msg.swipes[msg.swipe_id] !== undefined) {
        return msg.swipes[msg.swipe_id];
    }
    return msg.mes || '';
}

// ============================================
// 이어서 채팅하기 / 뷰어 내 리마인드 추가
// ============================================

async function continueChat() {
    const r = currentRemind;
    if (!r) return;

    const context = api.getContext();
    const charIndex = (context?.characters || []).findIndex(c => c.avatar === r.avatar);
    if (charIndex === -1) {
        showToast('캐릭터를 찾을 수 없습니다.', 'error');
        return;
    }

    saveProgressNow();
    const info = { fileName: r.fileName, charAvatar: r.avatar, charIndex: String(charIndex) };
    closeRemindViewer();

    await openChat(info);
}

async function addRemindFromViewer() {
    const r = currentRemind;
    if (!r) return;

    const defaultRange = `${lastRenderedRange.from}-${lastRenderedRange.to}`;
    const rangeInput = await showPrompt(
        '저장할 메시지 범위 (현재 보는 페이지가 기본값)\n예: 120-130 / 120 / 비우면 전체',
        '🔖 이 구간 리마인드로 저장',
        defaultRange
    );
    if (rangeInput === null) return;

    let start = null;
    let end = null;
    const trimmed = rangeInput.trim();
    if (trimmed) {
        const match = trimmed.match(/^(\d+)\s*[-~]\s*(\d+)$/) || trimmed.match(/^(\d+)$/);
        if (!match) {
            showToast('범위 형식이 올바르지 않습니다. 예: 120-130', 'error');
            return;
        }
        start = parseInt(match[1], 10);
        end = match[2] !== undefined ? parseInt(match[2], 10) : start;
        if (end < start) [start, end] = [end, start];

        // 채팅 길이 기준 보정 (배포용 안전망)
        if (currentMessages) {
            const total = currentMessages.length;
            if (start > total - 1) {
                showToast(`이 채팅은 #${total - 1}까지만 있어요. 범위를 확인해주세요.`, 'error');
                return;
            }
            if (end > total - 1) end = total - 1;
        }
    }

    const note = await showPrompt('메모를 남겨주세요.', '🔖 리마인드 메모', '');
    if (note === null) return;

    remindStore.add({
        avatar: r.avatar,
        charName: r.charName,
        fileName: r.fileName,
        start,
        end,
        note: note.trim(),
    });

    showToast(`🔖 리마인드 저장됨${start !== null ? ` (#${start}~#${end})` : ''}`, 'success');
}

// ============================================
// 형광펜
// ============================================

function hideHighlightPopup() {
    const popup = document.getElementById('remind-hl-popup');
    if (popup) popup.style.display = 'none';
}

function handleTextSelection() {
    const popup = document.getElementById('remind-hl-popup');
    const panel = document.querySelector('#chat-lobby-remind-viewer .remind-viewer-panel');
    if (!popup || !panel) return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        hideHighlightPopup();
        return;
    }

    const text = sel.toString().trim();
    if (!text || text.length < 2 || text.length > 600) {
        hideHighlightPopup();
        return;
    }

    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const anchorEl = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
    const article = anchorEl?.closest?.('.remind-msg');
    if (!article || !article.dataset.mesid) {
        hideHighlightPopup();
        return;
    }

    pendingHighlight = {
        mesid: parseInt(article.dataset.mesid, 10),
        text,
    };

    const rect = range.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const left = Math.min(panelRect.width - 110, Math.max(8, rect.left - panelRect.left));
    const top = Math.min(panelRect.height - 50, rect.bottom - panelRect.top + 8);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.display = 'flex';
}

function saveHighlightFromSelection() {
    if (!pendingHighlight || !currentRemind) {
        hideHighlightPopup();
        return;
    }

    const { mesid, text } = pendingHighlight;
    const entry = highlightStore.add({
        avatar: currentRemind.avatar,
        fileName: currentRemind.fileName,
        mesid,
        text,
    });

    const article = document.querySelector(`#chat-lobby-remind-viewer .remind-msg[data-mesid="${mesid}"] .remind-msg-body`);
    if (article) {
        wrapTextOccurrence(article, text, entry.id);
    }

    window.getSelection()?.removeAllRanges();
    pendingHighlight = null;
    hideHighlightPopup();
    showToast('🖍️ 형광펜 저장됨 (탭하면 제거)', 'success', 1800);
}

function wrapTextOccurrence(rootEl, searchText, hlId) {
    if (!rootEl || !searchText) return false;

    const full = rootEl.textContent;
    const idx = full.indexOf(searchText);
    if (idx === -1) return false;
    const endIdx = idx + searchText.length;

    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    let pos = 0;
    const targets = [];
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const len = node.nodeValue.length;
        const nodeStart = pos;
        const nodeEnd = pos + len;
        if (nodeEnd > idx && nodeStart < endIdx) {
            targets.push({
                node,
                from: Math.max(0, idx - nodeStart),
                to: Math.min(len, endIdx - nodeStart),
            });
        }
        pos = nodeEnd;
        if (pos >= endIdx) break;
    }

    for (const t of targets) {
        try {
            const range = document.createRange();
            range.setStart(t.node, t.from);
            range.setEnd(t.node, t.to);
            const mark = document.createElement('mark');
            mark.className = 'remind-highlight';
            mark.dataset.hlId = hlId;
            range.surroundContents(mark);
        } catch (e) { /* 노드 경계 충돌 시 해당 조각만 건너뜀 */ }
    }
    return targets.length > 0;
}

function unwrapHighlight(hlId) {
    document.querySelectorAll(`#chat-lobby-remind-viewer mark[data-hl-id="${CSS.escape(hlId)}"]`)
        .forEach(mark => {
            while (mark.firstChild) {
                mark.parentNode.insertBefore(mark.firstChild, mark);
            }
            mark.remove();
        });
}

function applySavedHighlights(body) {
    if (!currentRemind) return;
    body.querySelectorAll('.remind-msg[data-mesid]').forEach(article => {
        const mesid = parseInt(article.dataset.mesid, 10);
        const hls = highlightStore.getForMessage(currentRemind.avatar, currentRemind.fileName, mesid);
        if (hls.length === 0) return;
        const msgBody = article.querySelector('.remind-msg-body');
        if (!msgBody) return;
        for (const hl of hls) {
            wrapTextOccurrence(msgBody, hl.text, hl.id);
        }
    });
}

// ============================================
// 라이트박스
// ============================================

function openLightbox(src, alt) {
    const lb = document.getElementById('remind-lightbox');
    if (!lb) return;
    lb.querySelector('.remind-lightbox-img').src = src;
    lb.querySelector('.remind-lightbox-img').alt = alt;
    lb.querySelector('.remind-lightbox-caption').textContent = alt;
    lb.classList.add('active');
}

function closeLightbox() {
    const lb = document.getElementById('remind-lightbox');
    if (lb) lb.classList.remove('active');
}

// ============================================
// 렌더링
// ============================================

function renderMessages(keepScroll = false) {
    const body = document.querySelector('#chat-lobby-remind-viewer .remind-viewer-body');
    const data = getCurrentSlice();
    if (!body || !data) return;

    const { slice, start } = data;

    if (slice.length === 0) {
        body.innerHTML = `<div class="remind-viewer-loading">⚠️ 해당 범위에 메시지가 없습니다. (채팅 길이: ${currentMessages.length})<br><small>◀ 버튼으로 이전 구간을 불러올 수 있어요.</small></div>`;
        updatePageControls(0, 0);
        return;
    }

    const pageSize = getPageSize();
    const totalPages = getTotalPages(slice.length);
    pageIndex = Math.min(totalPages - 1, Math.max(0, pageIndex));

    const pageStart = pageSize === 0 ? 0 : pageIndex * pageSize;
    const pageSlice = pageSize === 0 ? slice : slice.slice(pageStart, pageStart + pageSize);

    const userName = currentMessages.find(m => m.is_user)?.name || 'User';
    const charName = currentRemind.charName
        || currentMessages.find(m => !m.is_user && !m.is_system)?.name
        || 'Character';

    const prevScroll = body.scrollTop;

    let html = '';
    pageSlice.forEach((msg, i) => {
        const mesid = start + pageStart + i;

        const formatted = renderMessageHtml(msg, {
            characterName: charName,
            userName: userName,
            charAvatar: currentRemind.avatar,
            applyRegex: regexEnabled,
        });

        const roleClass = msg.is_user ? 'is-user' : (msg.is_system ? 'is-system' : 'is-char');
        html += `
        <article class="remind-msg ${roleClass}" data-mesid="${mesid}">
            <div class="remind-msg-meta">
                <span class="remind-msg-name">${escapeHtml(msg.name || (msg.is_user ? userName : charName))}</span>
                <span class="remind-msg-id">#${mesid}</span>
            </div>
            <div class="remind-msg-body">${formatted}</div>
        </article>`;
    });

    body.innerHTML = html;
    body.scrollTop = keepScroll ? prevScroll : 0;

    const rangeFrom = start + pageStart;
    const rangeTo = start + pageStart + pageSlice.length - 1;
    lastRenderedRange = { from: rangeFrom, to: rangeTo };
    updatePageControls(totalPages, slice.length, rangeFrom, rangeTo);

    document.getElementById('remind-viewer-header')?.classList.remove('header-hidden');
    hideHighlightPopup();
    hideSettingsPop();

    hydrateRegexIframes(body);
    applySavedHighlights(body);
}

function updatePageControls(totalPages, rangeLength, rangeFrom = 0, rangeTo = 0) {
    const label = document.getElementById('remind-page-label');
    const prevBtn = document.getElementById('remind-page-prev');
    const nextBtn = document.getElementById('remind-page-next');
    const total = currentMessages?.length || 0;

    if (label) {
        if (rangeLength === 0) {
            label.textContent = '-';
        } else if (totalPages <= 1) {
            label.textContent = `#${rangeFrom}~#${rangeTo}`;
        } else {
            label.textContent = `#${rangeFrom}~#${rangeTo} (${pageIndex + 1}/${totalPages})`;
        }
    }

    if (prevBtn) prevBtn.disabled = pageIndex <= 0 && viewStart <= 0;
    if (nextBtn) nextBtn.disabled = pageIndex >= totalPages - 1 && viewEnd >= total - 1;
}

function hydrateRegexIframes(scope) {
    scope.querySelectorAll('iframe.remind-regex-iframe[data-remind-html]').forEach(iframe => {
        const b64 = iframe.getAttribute('data-remind-html');
        iframe.removeAttribute('data-remind-html');
        if (!b64) return;

        try {
            iframe.srcdoc = decodeURIComponent(escape(atob(b64)));
        } catch (e) {
            console.warn('[RemindViewer] iframe srcdoc set failed:', e);
            iframe.replaceWith(Object.assign(document.createElement('div'), {
                className: 'remind-html-notice',
                textContent: '🧩 HTML 블록을 표시하지 못했습니다.',
            }));
            return;
        }

        iframe.addEventListener('load', () => {
            setTimeout(() => {
                if (!iframe.style.height || iframe.style.height === '0px') {
                    iframe.style.height = '400px';
                }
            }, 800);
        });
    });
}

// ============================================
// 백업 (.txt 다운로드)
// ============================================

function exportCurrentRange() {
    const data = getCurrentSlice();
    if (!data || data.slice.length === 0) {
        showToast('내보낼 메시지가 없습니다.', 'warning');
        return;
    }

    const { slice, start } = data;
    const r = currentRemind;
    const rangeText = `#${viewStart}~#${viewEnd}`;

    let text = `🔖 ${r.charName} - ${r.fileName} (${rangeText})\n`;
    if (r.note) text += `메모: ${r.note}\n`;
    text += `백업일: ${new Date().toLocaleString('ko-KR')}\n`;
    text += '='.repeat(40) + '\n\n';

    slice.forEach((msg, i) => {
        text += `[#${start + i}] ${msg.name || (msg.is_user ? 'User' : r.charName)}\n`;
        text += resolveMes(msg) + '\n\n';
        text += '-'.repeat(40) + '\n\n';
    });

    const safeName = `${r.charName}_${r.fileName}_${rangeText}`.replace(/[\\/:*?"<>|#~\s]+/g, '_');
    const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `remind_${safeName}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showToast('💾 텍스트 파일로 백업했습니다.', 'success');
}
