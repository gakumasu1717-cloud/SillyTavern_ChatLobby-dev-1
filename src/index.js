// ============================================
// ChatLobby 메인 진입점
// ============================================

import { CONFIG } from './config.js';
import { cache } from './data/cache.js';
import { api } from './api/sillyTavern.js';
import { createLobbyHTML } from './ui/templates.js';
import { renderPersonaBar } from './ui/personaBar.js';
import { renderCharacterGrid } from './ui/characterGrid.js';

// 모듈화된 기능 임포트
import { setupHandlers, removeExistingUI, startBackgroundPreload, openLobby } from './ui/lobbyManager.js';
import { setupEventDelegation, cleanupEventDelegation } from './events/delegation.js';
import { setupSillyTavernEvents, cleanupSillyTavernEvents } from './events/stEvents.js';
import { addLobbyToOptionsMenu, addToCustomThemeSidebar, cleanupIntegration } from './ui/integration.js';
import { intervalManager } from './utils/intervalManager.js';

(function() {
    'use strict';
    
    // ============================================
    // 초기화
    // ============================================
    
    /**
     * 익스텐션 초기화
     * @returns {Promise<void>}
     */
    async function init() {
        
        // 기존 UI 제거
        removeExistingUI();
        
        // UI 삽입
        document.body.insertAdjacentHTML('beforeend', createLobbyHTML());
        
        // FAB 버튼 표시
        const fab = document.getElementById('chat-lobby-fab');
        if (fab) {
            fab.style.display = 'flex';
        }
        
        // 핸들러 연결
        setupHandlers();
        
        // 이벤트 위임 설정
        setupEventDelegation();
        
        // SillyTavern 이벤트 리스닝
        setupSillyTavernEvents();
        
        // 백그라운드 프리로딩 시작
        startBackgroundPreload();
        
        // 옵션 메뉴에 버튼 추가
        addLobbyToOptionsMenu();
        
        // CustomTheme 사이드바에 버튼 추가 (있으면)
        setTimeout(() => addToCustomThemeSidebar(), CONFIG.timing.initDelay);
        
    }
    
    /**
     * 전역 정리 함수 (확장 재로드 시 호출)
     * 모든 이벤트 리스너, observer, 메모리 정리
     * ⚠️ idempotent: 여러 번 호출해도 안전해야 함
     */
    function cleanup() {
        cleanupEventDelegation();
        cleanupSillyTavernEvents();
        cleanupIntegration();
        intervalManager.clearAll();  // 전역 타이머 정리
        removeExistingUI();
    }
    
    // 전역 API (네임스페이스 정리)
    window.ChatLobby = window.ChatLobby || {};
    
    // 기존 인스턴스 정리 (확장 재로드 대비)
    if (window.ChatLobby._cleanup) {
        window.ChatLobby._cleanup();
    }
    window.ChatLobby._cleanup = cleanup;
    
    window.ChatLobby.refresh = async function() {
        cache.invalidateAll();
        
        // SillyTavern의 캐릭터 목록 강제 갱신
        const context = api.getContext();
        if (typeof context?.getCharacters === 'function') {
            await context.getCharacters();
        }
        
        await renderPersonaBar();
        await renderCharacterGrid();
    };
    // 하위 호환성 유지
    window.chatLobbyRefresh = window.ChatLobby.refresh;
    
    // ============================================
    // DOM 로드 후 초기화
    // ============================================
    
    /**
     * SillyTavern 컨텍스트가 준비될 때까지 대기
     * @param {number} maxAttempts - 최대 시도 횟수
     * @param {number} interval - 시도 간격 (ms)
     * @returns {Promise<boolean>} 성공 여부
     */
    async function waitForSillyTavern(maxAttempts = 30, interval = 500) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const context = window.SillyTavern?.getContext?.();
            if (context && context.characters) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, interval));
        }
        console.error('[ChatLobby] SillyTavern context not available after', maxAttempts * interval, 'ms');
        return false;
    }
    
    /**
     * 초기화 완료 후 로비 자동 열기
     */
    async function initAndOpen() {
        // SillyTavern 컨텍스트가 준비될 때까지 대기
        const isReady = await waitForSillyTavern();
        if (!isReady) {
            console.error('[ChatLobby] Cannot initialize - SillyTavern not ready');
            return;
        }
        
        await init();
        // 초기화 완료 후 로비 자동 열기
        setTimeout(() => {
            openLobby();
        }, 100);
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(initAndOpen, CONFIG.timing.initDelay));
    } else {
        setTimeout(initAndOpen, CONFIG.timing.initDelay);
    }
    
})();
