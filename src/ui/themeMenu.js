// ============================================
// 테마 / 표시 설정 메뉴
//
// 테마는 단순 색상 교체(색깔놀이)가 아니라 data-lobby-theme 속성으로
// 레이아웃/카드 형태 자체가 바뀌는 스킨 시스템:
// - default   시네마 다크 (기존 넷플릭스 스타일)
// - light     모노 라이트 (기존 라이트)
// - glass     글래스 (반투명 블러 + 네온 글로우, 둥근 카드)
// - polaroid  폴라로이드 (사진 액자 + 이름 라벨, 따뜻한 종이 질감)
// - messenger 메신저 (그리드 → 리스트 뷰, 모바일 친화)
//
// base: 'dark'|'light' → 기존 dark-mode/light-mode 변수 팔레트를 베이스로 쓰고
// 테마별 CSS가 [data-lobby-theme="..."]로 덮어씀
// ============================================

import { uiPrefs } from '../data/uiPrefs.js';
import { listeners } from '../utils/listenerManager.js';
import { escapeHtml } from '../utils/textUtils.js';
import { openDrawerSafely } from '../utils/drawerHelper.js';

export const THEMES = [
    { id: 'default',   name: '시네마 다크',  icon: '🎬', base: 'dark',  desc: '넷플릭스 스타일' },
    { id: 'light',     name: '모노 라이트',  icon: '🤍', base: 'light', desc: '깔끔한 무채색' },
    { id: 'glass',     name: '글래스',      icon: '🫧', base: 'dark',  desc: '반투명 블러 + 글로우' },
    { id: 'polaroid',  name: '폴라로이드',  icon: '📸', base: 'light', desc: '사진 액자 컬렉션' },
    { id: 'messenger', name: '배너 리스트', icon: '💬', base: 'dark',  desc: '와이드 배너 · 모바일 추천' },
    { id: 'magazine',  name: '매거진',     icon: '🗞️', base: 'dark',  desc: '에디토리얼 화보 타이포' },
    { id: 'console',   name: '콘솔',       icon: '🛰️', base: 'dark',  desc: '실리 메뉴 도크 내장 · 실험적' },
];

/**
 * @param {string|null} id
 * @returns {{id:string,name:string,icon:string,base:string,desc:string}}
 */
export function getThemeById(id) {
    return THEMES.find(t => t.id === id) || THEMES[0];
}

/**
 * 테마 적용 (클래스 + data 속성 + 저장)
 * @param {string} themeId
 */
export function applyTheme(themeId) {
    const container = document.getElementById('chat-lobby-container');
    if (!container) return;

    const theme = getThemeById(themeId);
    container.classList.toggle('dark-mode', theme.base === 'dark');
    container.classList.toggle('light-mode', theme.base === 'light');
    container.dataset.lobbyTheme = theme.id;

    uiPrefs.set('theme', theme.id);

    // 메뉴 열려있으면 선택 표시 갱신
    const menu = document.getElementById('chat-lobby-theme-menu');
    if (menu) {
        menu.querySelectorAll('.theme-option').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === theme.id);
        });
    }
}

/**
 * 테마 메뉴 팝오버 HTML (템플릿에 삽입)
 * @returns {string}
 */
export function createThemeMenuHTML() {
    const currentTheme = getThemeById(uiPrefs.get('theme'));
    const showHero = uiPrefs.get('showHero');
    const personaBadges = uiPrefs.get('personaBadges');
    const cardSize = uiPrefs.get('cardSize');
    const badgeSize = uiPrefs.get('badgeSize');

    return `
    <div id="chat-lobby-theme-menu" style="display:none;">
        <div class="theme-menu-section-title">🎨 테마</div>
        <div class="theme-menu-grid">
            ${THEMES.map(t => `
                <button class="theme-option ${t.id === currentTheme.id ? 'active' : ''}"
                        data-action="set-theme" data-theme="${t.id}" title="${escapeHtml(t.desc)}">
                    <span class="theme-option-icon">${t.icon}</span>
                    <span class="theme-option-name">${escapeHtml(t.name)}</span>
                    <span class="theme-option-desc">${escapeHtml(t.desc)}</span>
                </button>
            `).join('')}
        </div>
        <div class="theme-menu-section-title">📐 크기</div>
        <div class="theme-menu-slider">
            <span class="slider-label">카드 크기</span>
            <input type="range" id="pref-card-size" min="140" max="280" step="10" value="${cardSize}">
            <span class="slider-value" id="pref-card-size-value">${cardSize}px</span>
        </div>
        <div class="theme-menu-slider">
            <span class="slider-label">페르소나 배지</span>
            <input type="range" id="pref-badge-size" min="24" max="64" step="2" value="${badgeSize}">
            <span class="slider-value" id="pref-badge-size-value">${badgeSize}px</span>
        </div>
        <div class="theme-menu-section-title">👁️ 표시</div>
        <label class="theme-menu-check">
            <input type="checkbox" id="pref-show-hero" ${showHero ? 'checked' : ''}>
            <span>⭐ 최애 코너 (즐겨찾기 배너)</span>
        </label>
        <label class="theme-menu-check">
            <input type="checkbox" id="pref-persona-badges" ${personaBadges ? 'checked' : ''}>
            <span>👤 카드에 마지막 페르소나 배지</span>
        </label>
    </div>
    `;
}

/**
 * 크기 환경설정을 컨테이너 CSS 변수로 적용
 * - --card-width: 캐릭터 그리드 카드 폭 (모바일 고정 컬럼 구간에서는 미적용)
 * - --persona-badge-size: 카드 페르소나 배지 크기
 */
export function applySizePrefs() {
    const container = document.getElementById('chat-lobby-container');
    if (!container) return;
    container.style.setProperty('--card-width', `${uiPrefs.get('cardSize')}px`);
    container.style.setProperty('--persona-badge-size', `${uiPrefs.get('badgeSize')}px`);
}

/**
 * 테마 메뉴 토글
 */
export function toggleThemeMenu() {
    const menu = document.getElementById('chat-lobby-theme-menu');
    if (!menu) return;
    const isOpen = menu.style.display !== 'none';
    menu.style.display = isOpen ? 'none' : 'block';
}

export function closeThemeMenu() {
    const menu = document.getElementById('chat-lobby-theme-menu');
    if (menu) menu.style.display = 'none';
}

export function isThemeMenuOpen() {
    const menu = document.getElementById('chat-lobby-theme-menu');
    return !!menu && menu.style.display !== 'none';
}

/**
 * 표시 옵션 체크박스 이벤트 바인딩
 * @param {() => void} onDisplayPrefChange - 옵션 변경 시 호출 (그리드 리렌더용)
 */
export function initThemeMenuEvents(onDisplayPrefChange) {
    const heroCb = document.getElementById('pref-show-hero');
    const badgeCb = document.getElementById('pref-persona-badges');
    const cardSlider = document.getElementById('pref-card-size');
    const badgeSlider = document.getElementById('pref-badge-size');

    listeners.add('themeMenu', heroCb, 'change', (e) => {
        uiPrefs.set('showHero', e.target.checked);
        onDisplayPrefChange?.();
    });

    listeners.add('themeMenu', badgeCb, 'change', (e) => {
        uiPrefs.set('personaBadges', e.target.checked);
        onDisplayPrefChange?.();
    });

    // 크기 슬라이더 - input은 실시간 반영(CSS 변수만), change에 저장
    listeners.add('themeMenu', cardSlider, 'input', (e) => {
        const v = parseInt(e.target.value, 10);
        uiPrefs.set('cardSize', v);
        applySizePrefs();
        const label = document.getElementById('pref-card-size-value');
        if (label) label.textContent = `${v}px`;
    });

    listeners.add('themeMenu', badgeSlider, 'input', (e) => {
        const v = parseInt(e.target.value, 10);
        uiPrefs.set('badgeSize', v);
        applySizePrefs();
        const label = document.getElementById('pref-badge-size-value');
        if (label) label.textContent = `${v}px`;
    });

    // 초기 적용
    applySizePrefs();
}

// ============================================
// ST 메뉴 도크 (콘솔 테마 전용)
// 로비 안에서 실리태번 기본 메뉴(프리셋/연결/포매팅/월드인포/
// 설정/확장/페르소나/캐릭터 패널)로 바로 점프하는 사이드 도크
// ============================================

/**
 * 도크 항목 정의
 * ids: ST 버전에 따라 드로어 홀더 id가 다를 수 있어 후보를 순서대로 탐색.
 * 렌더 시점에 .drawer-content가 실제 존재하는 항목만 노출 → 버전 차이에 안전
 */
const ST_DOCK_ITEMS = [
    { icon: '🧠', label: '프리셋',   ids: ['leftNavHolder', 'ai-response-configuration', 'respective-presets-button'] },
    { icon: '🔌', label: '연결',     ids: ['sys-settings-button', 'API-status-top', 'api-connections-button'] },
    { icon: '🅰️', label: '포매팅',  ids: ['advanced-formatting-button', 'AdvancedFormatting'] },
    { icon: '📚', label: '월드인포', ids: ['WI-SP-button', 'WIDrawerIcon', 'WorldInfo', 'world_info'] },
    { icon: '⚙️', label: '설정',     ids: ['user-settings-button'] },
    { icon: '🖼️', label: '배경',     ids: ['logo_block', 'backgrounds-button'] },
    { icon: '🧩', label: '확장',     ids: ['extensions-settings-button', 'rm_extensions_block'] },
    { icon: '👤', label: '페르소나', ids: ['persona-management-button'] },
    { icon: '🪪', label: '캐릭터',   ids: ['rightNavHolder'] },
];

/**
 * 후보 id 중 실제로 열 수 있는 드로어 홀더 id 찾기
 * @param {string[]} ids
 * @returns {string|null}
 */
function resolveDrawerId(ids) {
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.querySelector('.drawer-content')) return id;
    }
    return null;
}

/**
 * ST 도크 렌더링 + 이벤트 바인딩 (1회)
 * 도크 자체는 항상 DOM에 있고, 콘솔 테마에서만 CSS로 표시됨
 */
export function renderStDock() {
    const dock = document.getElementById('chat-lobby-st-dock');
    if (!dock) return;

    // 현재 ST에 존재하는 메뉴만 노출
    const items = ST_DOCK_ITEMS
        .map(item => ({ ...item, resolvedId: resolveDrawerId(item.ids) }))
        .filter(item => item.resolvedId);

    dock.innerHTML = `
        <div class="st-dock-title">ST</div>
        ${items.map(item => `
            <button class="st-dock-btn" data-drawer-id="${escapeHtml(item.resolvedId)}" title="${escapeHtml(item.label)}">
                <span class="st-dock-icon">${item.icon}</span>
                <span class="st-dock-label">${escapeHtml(item.label)}</span>
            </button>
        `).join('')}
    `;

    // 위임 바인딩 (1회)
    if (dock.dataset.bound !== 'true') {
        dock.dataset.bound = 'true';
        listeners.add('stDock', dock, 'click', async (e) => {
            const btn = e.target.closest('.st-dock-btn');
            if (!btn) return;

            const drawerId = btn.dataset.drawerId;
            if (!drawerId) return;

            // 로비를 닫고(상태 유지) ST 드로어 열기
            window.dispatchEvent(new CustomEvent('chatlobby:close'));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            openDrawerSafely(drawerId);
        });
    }
}

/**
 * 정리 (확장 재로드 시)
 */
export function cleanupThemeMenu() {
    listeners.clear('themeMenu');
    listeners.clear('stDock');
}
