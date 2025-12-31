import { cache } from '../data/cache.js';
import { store } from '../data/store.js';
import { renderCharacterGrid } from '../ui/characterGrid.js';
import { isLobbyOpen } from '../ui/lobbyManager.js';

// ============================================
// 이벤트 핸들러 참조 저장 (cleanup용)
// ============================================
let eventHandlers = null;
let eventsRegistered = false;

/**
 * SillyTavern 이벤트 리스닝 설정
 * 캐릭터 삭제/추가/수정 등의 이벤트를 감지하여 캐시 무효화
 * 중복 등록 방지 + cleanup 지원
 */
export function setupSillyTavernEvents() {
    const context = window.SillyTavern?.getContext?.();
    if (!context?.eventSource) {
        console.warn('[ChatLobby] SillyTavern eventSource not found');
        return;
    }
    
    // 이미 등록되어 있으면 스킵
    if (eventsRegistered) {
        return;
    }
    
    const { eventSource, eventTypes } = context;
    
    // 핸들러 함수들을 별도로 정의 (off 호출 가능하도록)
    eventHandlers = {
        onCharacterDeleted: () => {
            cache.invalidate('characters');
            if (isLobbyOpen()) {
                renderCharacterGrid(store.searchTerm);
            }
        },
        onCharacterEdited: () => {
            cache.invalidate('characters');
        },
        onCharacterAdded: () => {
            cache.invalidate('characters');
            if (isLobbyOpen()) {
                renderCharacterGrid(store.searchTerm);
            }
        },
        onChatChanged: () => {
            cache.invalidate('characters');
            cache.invalidate('chats');
            // 리렌더 제거 - 삭제는 deleteChat에서 element.remove()로 처리
        }
    };
    
    // 이벤트 등록
    eventSource.on(eventTypes.CHARACTER_DELETED, eventHandlers.onCharacterDeleted);
    
    if (eventTypes.CHARACTER_EDITED) {
        eventSource.on(eventTypes.CHARACTER_EDITED, eventHandlers.onCharacterEdited);
    }
    
    if (eventTypes.CHARACTER_ADDED) {
        eventSource.on(eventTypes.CHARACTER_ADDED, eventHandlers.onCharacterAdded);
    }
    
    eventSource.on(eventTypes.CHAT_CHANGED, eventHandlers.onChatChanged);
    
    eventsRegistered = true;
}

/**
 * SillyTavern 이벤트 리스너 정리
 * 확장 재로드 시 호출
 */
export function cleanupSillyTavernEvents() {
    if (!eventHandlers || !eventsRegistered) return;
    
    const context = window.SillyTavern?.getContext?.();
    if (!context?.eventSource) return;
    
    const { eventSource, eventTypes } = context;
    
    try {
        eventSource.off?.(eventTypes.CHARACTER_DELETED, eventHandlers.onCharacterDeleted);
        eventSource.off?.(eventTypes.CHARACTER_EDITED, eventHandlers.onCharacterEdited);
        eventSource.off?.(eventTypes.CHARACTER_ADDED, eventHandlers.onCharacterAdded);
        eventSource.off?.(eventTypes.CHAT_CHANGED, eventHandlers.onChatChanged);
        
        eventsRegistered = false;
        eventHandlers = null;
    } catch (e) {
        console.warn('[ChatLobby] Failed to cleanup events:', e);
    }
}
