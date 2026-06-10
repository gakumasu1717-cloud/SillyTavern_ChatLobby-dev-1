// ============================================
// 리마인드 뷰어
// 저장해 둔 채팅(구간)을 소설처럼 다시 읽기
// 연속 스크롤 + 메시지 단락 렌더링 (CHATNOVEL 뷰어 컨셉의 경량 재구현)
//
// 부하 대책:
// - 선택한 구간만 렌더 (보통 수십 개 메시지 → 가벼움)
// - 정규식 적용은 헤더의 ✨ 토글로 끌 수 있음 (스크립트가 많은 환경 대비)
// ============================================

import { api } from '../api/sillyTavern.js';
import { remindStore } from '../data/remindStore.js';
import { renderMessageHtml } from '../utils/chatTextFormatter.js';
import { escapeHtml } from '../utils/textUtils.js';
import { showToast } from './notifications.js';
import { listeners } from '../utils/listenerManager.js';

let isViewerOpen = false;

// 현재 뷰어 세션 상태 (재렌더용)
let currentRemind = null;
let currentMessages = null;
let regexEnabled = true;

/**
 * 뷰어 열기
 * @param {string} remindId - remindStore의 리마인드 ID
 */
export async function openRemindViewer(remindId) {
    const remind = remindStore.get(remindId);
    if (!remind) {
        showToast('리마인드를 찾을 수 없습니다.', 'error');
        return;
    }

    closeRemindViewer(); // 기존 뷰어 정리

    // ⚠️ 채팅 패널(#chat-lobby-chats)과 완전히 동일한 메커니즘:
    // 템플릿에 고정으로 존재하는 호스트 요소를 .visible 클래스로 열고 닫는다.
    // (동적 생성 + body append 방식은 모바일 커스텀 테마 환경에서 표시 실패)
    const overlay = document.getElementById('chat-lobby-remind-viewer');
    if (!overlay) {
        showToast('뷰어를 열 수 없습니다. 로비를 다시 열어주세요.', 'error');
        return;
    }

    currentRemind = remind;
    currentMessages = null;
    regexEnabled = true;

    const rangeText = (remind.start !== null || remind.end !== null)
        ? `#${remind.start ?? 0} ~ ${remind.end !== null ? '#' + remind.end : '끝'}`
        : '전체';

    overlay.innerHTML = `
        <div class="remind-viewer-panel">
            <header class="remind-viewer-header">
                <div class="remind-viewer-title">
                    <span class="remind-viewer-char">${escapeHtml(remind.charName || '')}</span>
                    <span class="remind-viewer-file">${escapeHtml(remind.fileName)} · ${escapeHtml(rangeText)}</span>
                    ${remind.note ? `<span class="remind-viewer-note">🔖 ${escapeHtml(remind.note)}</span>` : ''}
                </div>
                <div class="remind-viewer-actions">
                    <button class="remind-viewer-btn" id="remind-viewer-regex" title="ST 정규식 스크립트 적용 켜기/끄기">✨ 정규식 ON</button>
                    <button class="remind-viewer-btn" id="remind-viewer-export" title="이 구간을 텍스트 파일로 백업">💾 백업</button>
                    <button class="remind-viewer-close" title="닫기">✕</button>
                </div>
            </header>
            <div class="remind-viewer-body">
                <div class="remind-viewer-loading">📖 채팅을 불러오는 중...</div>
            </div>
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

    // 채팅 패널과 동일하게 .visible 클래스로 표시
    overlay.classList.add('visible');
    isViewerOpen = true;

    listeners.add('remindViewer', overlay.querySelector('.remind-viewer-close'), 'click', closeRemindViewer);
    listeners.add('remindViewer', overlay.querySelector('#remind-viewer-regex'), 'click', toggleRegex);
    listeners.add('remindViewer', overlay.querySelector('#remind-viewer-export'), 'click', exportCurrentRange);
    // 패널 밖(어두운 영역) 클릭 시 닫기
    listeners.add('remindViewer', overlay, 'click', (e) => {
        if (e.target === overlay) closeRemindViewer();
    });
    listeners.add('remindViewer', document, 'keydown', handleViewerKeydown);

    // 라이트박스 (CHATNOVEL 방식: 본문 이미지 클릭 위임)
    const viewerBody = overlay.querySelector('.remind-viewer-body');
    listeners.add('remindViewer', viewerBody, 'click', (e) => {
        const img = e.target.closest('img');
        if (img) {
            e.preventDefault();
            e.stopPropagation();
            openLightbox(img.src, img.alt || img.title || '');
        }
    });
    listeners.add('remindViewer', overlay.querySelector('.remind-lightbox-backdrop'), 'click', closeLightbox);
    listeners.add('remindViewer', overlay.querySelector('.remind-lightbox-close'), 'click', closeLightbox);

    // 이미지 로드 실패 폴백 (sanitize가 inline onerror를 제거하므로 capture 위임으로 처리)
    listeners.add('remindViewer', viewerBody, 'error', (e) => {
        const img = e.target;
        if (img?.tagName === 'IMG' && img.closest('.remind-image-container')) {
            img.closest('.remind-image-container').innerHTML =
                `<div class="remind-image-fallback">🖼️ ${escapeHtml(img.alt || '이미지를 찾을 수 없음')}</div>`;
        }
    }, true);

    // 정규식 iframe 높이 통신 (내부 주입 스크립트의 postMessage 수신)
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

    // 데이터 로드 + 렌더
    const body = overlay.querySelector('.remind-viewer-body');
    try {
        const messages = await api.getChatMessages(remind.avatar, remind.fileName);
        if (!messages || messages.length === 0) {
            body.innerHTML = '<div class="remind-viewer-loading">⚠️ 채팅을 불러오지 못했습니다. (파일이 삭제되었거나 이름이 바뀌었을 수 있어요)</div>';
            return;
        }
        currentMessages = messages;
        renderMessages();
    } catch (e) {
        console.error('[RemindViewer] Load failed:', e);
        body.innerHTML = '<div class="remind-viewer-loading">⚠️ 채팅 로딩 중 오류가 발생했습니다.</div>';
    }
}

/**
 * 뷰어 닫기
 */
export function closeRemindViewer() {
    const overlay = document.getElementById('chat-lobby-remind-viewer');
    if (overlay) {
        // 채팅 패널과 동일: 클래스 제거 + 내용 비우기 (요소 자체는 유지)
        overlay.classList.remove('visible');
        overlay.innerHTML = '';
    }
    listeners.clear('remindViewer');
    isViewerOpen = false;
    currentRemind = null;
    currentMessages = null;
}

/**
 * ESC 처리용: 최상위 레이어(라이트박스 → 뷰어) 하나만 닫기
 * index.js의 전역 keydown에서 호출
 * @returns {boolean} 닫은 게 있으면 true (이벤트 소비)
 */
export function closeTopRemindLayer() {
    if (!isViewerOpen) return false;

    const lb = document.getElementById('remind-lightbox');
    if (lb?.classList.contains('active')) {
        closeLightbox();
        return true;
    }
    closeRemindViewer();
    return true;
}

export function isRemindViewerOpen() {
    return isViewerOpen;
}

function handleViewerKeydown(e) {
    if (e.key === 'Escape' && isViewerOpen) {
        e.stopPropagation();
        // 라이트박스가 열려있으면 라이트박스만 닫기
        const lb = document.getElementById('remind-lightbox');
        if (lb?.classList.contains('active')) {
            closeLightbox();
            return;
        }
        closeRemindViewer();
    }
}

/**
 * 정규식 적용 토글 (무거운 스크립트 환경 대비)
 */
function toggleRegex() {
    regexEnabled = !regexEnabled;
    const btn = document.getElementById('remind-viewer-regex');
    if (btn) {
        btn.textContent = regexEnabled ? '✨ 정규식 ON' : '✨ 정규식 OFF';
        btn.classList.toggle('off', !regexEnabled);
    }
    renderMessages();
}

/**
 * 현재 구간의 메시지 슬라이스 가져오기
 * @returns {{ slice: Array, start: number }|null}
 */
function getCurrentSlice() {
    if (!currentRemind || !currentMessages) return null;
    const start = currentRemind.start ?? 0;
    const end = currentRemind.end ?? currentMessages.length - 1;
    return {
        slice: currentMessages.slice(Math.max(0, start), Math.min(currentMessages.length, end + 1)),
        start: Math.max(0, start),
    };
}

/**
 * 스와이프 반영된 메시지 본문 (백업용 - 원문 기준)
 */
function resolveMes(msg) {
    if (Array.isArray(msg.swipes) && typeof msg.swipe_id === 'number'
        && msg.swipes[msg.swipe_id] !== undefined) {
        return msg.swipes[msg.swipe_id];
    }
    return msg.mes || '';
}

/**
 * 라이트박스 열기/닫기
 */
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

/**
 * 메시지 목록 렌더링
 */
function renderMessages() {
    const body = document.querySelector('#chat-lobby-remind-viewer .remind-viewer-body');
    const data = getCurrentSlice();
    if (!body || !data) return;

    const { slice, start } = data;

    if (slice.length === 0) {
        body.innerHTML = `<div class="remind-viewer-loading">⚠️ 해당 범위에 메시지가 없습니다. (채팅 길이: ${currentMessages.length})</div>`;
        return;
    }

    const userName = currentMessages.find(m => m.is_user)?.name || 'User';
    const charName = currentRemind.charName
        || currentMessages.find(m => !m.is_user && !m.is_system)?.name
        || 'Character';

    let html = '';
    slice.forEach((msg, i) => {
        const mesid = start + i;

        // CHATNOVEL 파이프라인 (스와이프/정규식/이미지/iframe/마크다운/extra 이미지 포함)
        const formatted = renderMessageHtml(msg, {
            characterName: charName,
            userName: userName,
            charAvatar: currentRemind.avatar,
            applyRegex: regexEnabled,
        });

        const roleClass = msg.is_user ? 'is-user' : (msg.is_system ? 'is-system' : 'is-char');
        html += `
        <article class="remind-msg ${roleClass}">
            <div class="remind-msg-meta">
                <span class="remind-msg-name">${escapeHtml(msg.name || (msg.is_user ? userName : charName))}</span>
                <span class="remind-msg-id">#${mesid}</span>
            </div>
            <div class="remind-msg-body">${formatted}</div>
        </article>`;
    });

    body.innerHTML = html;
    body.scrollTop = 0;

    // 정규식 iframe 하이드레이션 (base64 → srcdoc 주입)
    hydrateRegexIframes(body);
}

/**
 * sandboxed 정규식 iframe에 내용 주입 (CHATNOVEL 방식)
 * sanitize 단계에서 srcdoc이 제거되므로 렌더 후 base64를 디코딩해 주입
 * @param {HTMLElement} scope
 */
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

        // 안전망: 높이 메시지를 못 받으면 기본 높이
        iframe.addEventListener('load', () => {
            setTimeout(() => {
                if (!iframe.style.height || iframe.style.height === '0px') {
                    iframe.style.height = '400px';
                }
            }, 800);
        });
    });
}

/**
 * 현재 구간을 텍스트 파일로 백업 (.txt 다운로드)
 * 원문(raw) 기준 - 백업 목적이므로 정규식/마크다운 미적용
 */
function exportCurrentRange() {
    const data = getCurrentSlice();
    if (!data || data.slice.length === 0) {
        showToast('내보낼 메시지가 없습니다.', 'warning');
        return;
    }

    const { slice, start } = data;
    const r = currentRemind;
    const rangeText = r.start !== null ? `#${r.start}~#${r.end}` : '전체';

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
