import { CONFIG } from '../config.js';
import { store } from '../data/store.js';
import { storage } from '../data/storage.js';
import { cache } from '../data/cache.js';
import { api } from '../api/sillyTavern.js';
import { intervalManager } from '../utils/intervalManager.js';
import { renderPersonaBar } from './personaBar.js';
import { renderCharacterGrid, setCharacterSelectHandler } from './characterGrid.js';
import { renderChatList, setChatHandlers, closeChatPanel, toggleBatchMode, cleanupTooltip } from './chatList.js';
import { updateFolderDropdowns } from '../handlers/folderHandlers.js';
import { openChat, deleteChat } from '../handlers/chatHandlers.js';

/**
 * 로비가 열려있는지 확인
 */
export function isLobbyOpen() {
    return store.isLobbyOpen;
}

/**
 * 기존 UI 요소 제거
 */
export function removeExistingUI() {
    ['chat-lobby-overlay', 'chat-lobby-fab', 'chat-lobby-folder-modal', 'chat-lobby-global-tooltip', 'chat-preview-tooltip'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.remove();
    });
}

/**
 * 핸들러 설정
 */
export function setupHandlers() {
    // 캐릭터 선택 시 채팅 목록 렌더링
    setCharacterSelectHandler((character) => {
        renderChatList(character);
    });
    
    // 채팅 열기/삭제 핸들러
    setChatHandlers({
        onOpen: openChat,
        onDelete: deleteChat
    });
}

/**
 * 백그라운드 프리로딩 시작
 */
export async function startBackgroundPreload() {
    // 약간의 딜레이 후 프리로딩 (메인 스레드 블로킹 방지)
    setTimeout(async () => {
        await cache.preloadAll(api);
        
        // 최근 사용 캐릭터들의 채팅도 프리로딩
        const characters = cache.get('characters');
        if (characters && characters.length > 0) {
            // 최근 채팅순으로 정렬된 상위 5개
            const recent = [...characters]
                .sort((a, b) => (b.date_last_chat || 0) - (a.date_last_chat || 0))
                .slice(0, 5);
            await cache.preloadRecentChats(api, recent);
        }
    }, CONFIG.timing.preloadDelay);
}

/**
 * 로비 열기
 * 캐시는 이벤트로 동기화함 (onChatChanged)
 */
export async function openLobby() {
    // 이미 열려있고 채팅 패널이 표시 중이면 무시
    const chatsPanel = document.getElementById('chat-lobby-chats');
    if (store.isLobbyOpen && chatsPanel?.classList.contains('visible')) {
        return;
    }
    
    const overlay = document.getElementById('chat-lobby-overlay');
    const container = document.getElementById('chat-lobby-container');
    const fab = document.getElementById('chat-lobby-fab');
    
    if (overlay) {
        overlay.style.display = 'flex';
        if (container) container.style.display = 'flex';
        if (fab) fab.style.display = 'none';
        
        // 핸들러가 설정되어 있는지 확인
        if (!store.onCharacterSelect) {
            console.warn('[ChatLobby] Handler not set, re-running setupHandlers');
            setupHandlers();
        }
        
        // 상태 초기화 (이전 선택 정보 클리어, 핸들러는 유지)
        store.reset();
        store.setLobbyOpen(true);
        
        // SillyTavern 캐릭터 목록 최신화
        try {
            const context = api.getContext();
            if (typeof context?.getCharacters === 'function') {
                await context.getCharacters();
            }
        } catch (error) {
            console.warn('[ChatLobby] Failed to refresh characters:', error);
        }
        
        // 폴더 필터 강제 리셋 (버그 방지)
        // 존재하지 않는 폴더로 필터링되어 채팅이 안 보이는 문제 해결
        const data = storage.load();
        if (data.filterFolder && data.filterFolder !== 'all' && data.filterFolder !== 'favorites' && data.filterFolder !== 'uncategorized') {
            const folderExists = data.folders?.some(f => f.id === data.filterFolder);
            if (!folderExists) {
                storage.setFilterFolder('all');
            }
        }
        
        // 배치 모드 리셋
        if (store.batchModeActive) {
            toggleBatchMode();
        }
        
        // 채팅 패널 닫기 (이전 캐릭터 선택 상태 클리어)
        closeChatPanel();
        
        // 렌더링 (context에서 직접 가져오므로 항상 최신)
        renderPersonaBar();
        renderCharacterGrid();
        
        // 폴더 드롭다운 업데이트
        updateFolderDropdowns();
        
        // 현재 채팅 중인 캐릭터 자동 선택
        const currentContext = api.getContext();
        if (currentContext?.characterId !== undefined && currentContext.characterId >= 0) {
            const currentChar = currentContext.characters?.[currentContext.characterId];
            if (currentChar) {
                // 렌더링 완료 후 선택
                setTimeout(() => {
                    const charCard = document.querySelector(
                        `.lobby-char-card[data-char-avatar="${currentChar.avatar}"]`
                    );
                    if (charCard) {
                        charCard.classList.add('selected');
                        // 채팅 목록도 로드
                        const characterData = {
                            index: currentContext.characterId,
                            avatar: currentChar.avatar,
                            name: currentChar.name,
                            avatarSrc: `/characters/${encodeURIComponent(currentChar.avatar)}`
                        };
                        renderChatList(characterData);
                    }
                }, 200);
            }
        }
        
    }
}

/**
 * 로비 닫기 (상태 초기화)
 * - 로비를 완전히 닫을 때 사용
 * - 캐릭터/채팅 선택 상태를 초기화함
 * - ESC 키, 닫기 버튼, 오버레이 클릭 시 사용
 */
export async function closeLobby() {
    const container = document.getElementById('chat-lobby-container');
    const fab = document.getElementById('chat-lobby-fab');
    
    if (container) container.style.display = 'none';
    if (fab) fab.style.display = 'flex';
    
    // 🧹 모든 interval 정리 (메모리 누수 방지)
    intervalManager.clearAll();
    
    // 🧹 tooltip element 정리 (메모리 누수 방지)
    cleanupTooltip();
    
    // CustomTheme 사이드바 버튼 상태 초기화
    const sidebarBtn = document.getElementById('st-chatlobby-sidebar-btn');
    if (sidebarBtn) {
        const icon = sidebarBtn.querySelector('.drawer-icon');
        icon?.classList.remove('openIcon');
        icon?.classList.add('closedIcon');
    }
    
    store.setLobbyOpen(false);
    store.reset(); // 상태 초기화
    closeChatPanel();
}
