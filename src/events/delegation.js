import { store } from '../data/store.js';
import { openLobby, closeLobby } from '../ui/lobbyManager.js';
import { handleKeydown } from './keyboardEvents.js';
import { handleSearch, handleSortChange as handleCharSortChange, renderCharacterGrid } from '../ui/characterGrid.js';
import { handleFilterChange, handleSortChange as handleChatSortChange, updateBatchCount, toggleBatchMode, closeChatPanel } from '../ui/chatList.js';
import { openStatsView, closeStatsView } from '../ui/statsView.js';
import { startNewChat, deleteCharacter } from '../handlers/chatHandlers.js';
import { openFolderModal, closeFolderModal, addFolder } from '../handlers/folderHandlers.js';
import { handleRefresh, handleImportCharacter, handleAddPersona, handleGoToCharacter } from '../handlers/lobbyActions.js';

// 이벤트 리스너 중복 등록 방지 플래그
let eventsInitialized = false;

// 이벤트 핸들러 참조 저장 (cleanup용)
let refreshGridHandler = null;

/**
 * 이벤트 위임 설정
 * getElementById 대신 상위 컨테이너에서 이벤트를 위임 처리
 */
export function setupEventDelegation() {
    if (eventsInitialized) return;
    eventsInitialized = true;
    
    // FAB 버튼 (document.body에 위임)
    document.body.addEventListener('click', handleBodyClick);
    
    // 키보드 이벤트
    document.addEventListener('keydown', handleKeydown);
    
    // 검색 입력 (input 이벤트는 위임이 잘 안되므로 직접 바인딩)
    const searchInput = document.getElementById('chat-lobby-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => handleSearch(e.target.value));
    }
    
    // 드롭다운 change 이벤트도 직접 바인딩
    bindDropdownEvents();
    
    // 순환참조 방지용 이벤트 리스너
    refreshGridHandler = () => {
        renderCharacterGrid(store.searchTerm);
    };
    window.addEventListener('chatlobby:refresh-grid', refreshGridHandler);
}

/**
 * 이벤트 위임 정리 (확장 재로드 대비)
 */
export function cleanupEventDelegation() {
    if (!eventsInitialized) return;
    
    document.body.removeEventListener('click', handleBodyClick);
    document.removeEventListener('keydown', handleKeydown);
    
    if (refreshGridHandler) {
        window.removeEventListener('chatlobby:refresh-grid', refreshGridHandler);
        refreshGridHandler = null;
    }
    
    eventsInitialized = false;
}

/**
 * body 클릭 이벤트 핸들러 (이벤트 위임)
 * @param {MouseEvent} e
 */
function handleBodyClick(e) {
    const target = e.target;
    
    // FAB 버튼은 로비 외부에 있으므로 별도 처리
    if (target.id === 'chat-lobby-fab' || target.closest('#chat-lobby-fab')) {
        openLobby();
        return;
    }
    
    // 로비 컨테이너 내부 클릭만 처리
    const lobbyContainer = target.closest('#chat-lobby-container');
    const folderModal = target.closest('#chat-lobby-folder-modal');
    
    if (!lobbyContainer && !folderModal) {
        // 로비 외부 클릭은 무시
        return;
    }
    
    // 캐릭터 카드나 채팅 아이템 클릭은 무시 (각자 핸들러가 있음)
    if (target.closest('.lobby-char-card') || target.closest('.lobby-chat-item')) {
        return;
    }
    
    // data-action 속성으로 액션 분기
    const actionEl = target.closest('[data-action]');
    if (actionEl) {
        handleAction(actionEl.dataset.action, actionEl, e);
        return;
    }
}

/**
 * data-action 기반 액션 처리
 * @param {string} action - 액션 이름
 * @param {HTMLElement} el - 트리거 요소
 * @param {Event} e - 이벤트 객체
 */
async function handleAction(action, el, e) {
    switch (action) {
        case 'open-lobby':
            openLobby();
            break;
        case 'close-lobby':
            await closeLobby();
            break;
        case 'open-stats':
            openStatsView();
            break;
        case 'close-stats':
            closeStatsView();
            break;
        case 'refresh':
            handleRefresh();
            break;
        case 'new-chat':
            startNewChat();
            break;
        case 'delete-char':
            deleteCharacter();
            break;
        case 'import-char':
            handleImportCharacter();
            break;
        case 'add-persona':
            handleAddPersona();
            break;
        case 'toggle-batch':
            toggleBatchMode();
            break;
        case 'batch-cancel':
            toggleBatchMode();
            break;
        case 'open-folder-modal':
            openFolderModal();
            break;
        case 'close-folder-modal':
            closeFolderModal();
            break;
        case 'add-folder':
            addFolder();
            break;
        case 'close-chat-panel':
            // CSS에서 850px 이하일 때만 버튼이 보이므로, 조건 체크 불필요
            closeChatPanel();
            break;
        case 'go-to-character':
            handleGoToCharacter();
            break;
    }
}

/**
 * 드롭다운 이벤트 바인딩
 */
function bindDropdownEvents() {
    // 캐릭터 정렬
    document.getElementById('chat-lobby-char-sort')?.addEventListener('change', (e) => {
        handleCharSortChange(e.target.value);
    });
    
    // 채팅 필터
    document.getElementById('chat-lobby-folder-filter')?.addEventListener('change', (e) => {
        handleFilterChange(e.target.value);
    });
    
    // 채팅 정렬
    document.getElementById('chat-lobby-chat-sort')?.addEventListener('change', (e) => {
        handleChatSortChange(e.target.value);
    });
    
    // 배치 체크박스 변경 (위임)
    document.getElementById('chat-lobby-chats-list')?.addEventListener('change', (e) => {
        if (e.target.classList.contains('chat-select-cb')) {
            updateBatchCount();
        }
    });
}
