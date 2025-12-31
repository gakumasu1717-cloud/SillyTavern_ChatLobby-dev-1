import { store } from '../data/store.js';
import { isStatsViewOpen, closeStatsView } from '../ui/statsView.js';
import { closeFolderModal, addFolder } from '../handlers/folderHandlers.js';
import { closeLobby } from '../ui/lobbyManager.js';

/**
 * 키보드 이벤트 핸들러
 * @param {KeyboardEvent} e
 */
export function handleKeydown(e) {
    if (e.key === 'Escape') {
        // 통계 화면 열려있으면 먼저 닫기
        if (isStatsViewOpen()) {
            closeStatsView();
            return;
        }
        
        const folderModal = document.getElementById('chat-lobby-folder-modal');
        if (folderModal?.style.display === 'flex') {
            closeFolderModal();
        } else if (store.isLobbyOpen) {
            closeLobby();
        }
    }
    
    // 폴더 추가 Enter 키
    if (e.key === 'Enter' && e.target.id === 'new-folder-name') {
        addFolder();
    }
}
