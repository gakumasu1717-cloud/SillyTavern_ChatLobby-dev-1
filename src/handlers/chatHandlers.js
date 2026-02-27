// ============================================
// 채팅 관련 이벤트 핸들러
// ============================================

import { api } from '../api/sillyTavern.js';
import { operationLock } from '../utils/operationLock.js';
import { cache } from '../data/cache.js';
import { storage } from '../data/storage.js';
import { store } from '../data/store.js';
import { lastChatCache } from '../data/lastChatCache.js';
import { refreshChatList, getCurrentCharacter, closeChatPanel } from '../ui/chatList.js';
import { showToast, showConfirm, showAlert } from '../ui/notifications.js';
import { CONFIG } from '../config.js';
import { waitFor, waitForCharacterSelect, waitForElement, waitForChatChanged } from '../utils/waitFor.js';
import { isMobile } from '../utils/eventHelpers.js';
import { startRecentDomObserver } from '../ui/tabView.js';

// ============================================
// 채팅 열기
// ============================================

/**
 * 채팅 열기
 * @param {{ fileName: string, charAvatar: string, charIndex: string }} chatInfo
 * @returns {Promise<void>}
 */
export async function openChat(chatInfo) {
    if (!operationLock.acquire('openChat')) return;
    
    const { fileName, charAvatar, charIndex } = chatInfo;
    
    console.debug('[ChatHandlers] openChat called:', { fileName, charAvatar, charIndex });
    
    let lobbyHidden = false;
    try {
        if (!charAvatar || !fileName) {
            console.error('[ChatHandlers] Missing chat data');
            showToast('채팅 정보가 올바르지 않습니다.', 'error');
            return;
        }
        
        const context = api.getContext();
        const characters = context?.characters || [];
        const index = characters.findIndex(c => c.avatar === charAvatar);
        
        console.debug('[ChatHandlers] Character index:', index);
        
        if (index === -1) {
            console.error('[ChatHandlers] Character not found');
            showToast('캐릭터를 찾을 수 없습니다.', 'error');
            return;
        }
        
        // 파일명 정규화 (확장자 제거)
        const chatFileName = fileName.replace('.jsonl', '');
        
        // ★ 마지막 채팅 시간 갱신은 실제 메시지 송수신 시에만 (index.js의 MESSAGE_SENT/RECEIVED 이벤트)
        // 채팅 열기만으로는 갱신하지 않음 - "최근 채팅순"은 실제 대화한 순서를 의미
        
        // 이미 같은 캐릭터가 선택되어 있는지 확인
        const currentChar = context.characters?.[context.characterId];
        const isSameCharacter = currentChar?.avatar === charAvatar;
        
        if (!isSameCharacter) {
            // 다른 캐릭터인 경우에만 selectCharacterById 호출
            console.debug('[ChatHandlers] Different character, selecting...');
            
            // ⚠️ 리스너 먼저 등록 → 그 다음 selectCharacterById 호출
            // (selectCharacterById가 완료되면 CHAT_CHANGED는 이미 발행된 뒤)
            const chatChangedPromise = waitForChatChanged(5000);
            await api.selectCharacterById(index);
            
            // CHAT_CHANGED 이벤트 대기 (ST의 save/load 완료 확인)
            const chatChanged = await chatChangedPromise;
            console.debug('[ChatHandlers] Chat changed event received:', chatChanged);
            
            if (!chatChanged) {
                // 타임아웃된 경우 avatar만이라도 확인
                const charSelected = await waitForCharacterSelect(charAvatar, 2000);
                if (!charSelected) {
                    showToast('캐릭터 선택에 실패했습니다. 다시 시도해주세요.', 'error');
                    return;
                }
            }
            
            // 🔥 FIX: 300ms 하드코딩 → 상태 폴링 검증
            // 캐릭터 전환 후 채팅 데이터가 메모리에 완전히 로드될 때까지 확인
            const stateReady = await waitFor(() => {
                const ctx = api.getContext();
                const cur = ctx?.characters?.[ctx?.characterId];
                // 새 캐릭터가 선택되었고, chat 파일명이 할당되었는지 확인
                return cur?.avatar === charAvatar && !!cur?.chat;
            }, 3000, 100);
            
            if (!stateReady) {
                console.warn('[ChatHandlers] Character state not ready after switch, adding safety delay');
                await new Promise(r => setTimeout(r, 500));
            }
        } else {
            console.debug('[ChatHandlers] Same character already selected, skipping selectCharacterById');
        }
        
        // 🔥 FIX: closeLobbyKeepState() 대신 UI만 먼저 숨김
        // closeLobbyKeepState()는 startRecentDomObserver()를 호출하므로
        // 채팅 전환 중 Observer가 DOM 변경에 반응하여 캐시를 오염시키는 것을 방지
        hideLobbyUI();
        lobbyHidden = true;
        
        // SillyTavern openCharacterChat 함수 사용 (fresh context)
        const freshContext = api.getContext();
        console.debug('[ChatHandlers] Opening chat:', chatFileName);
        if (typeof freshContext?.openCharacterChat === 'function') {
            try {
                // ⚠️ openCharacterChat은 내부적으로 현재 채팅 저장 → 대상 채팅 로드를 수행
                // 리스너를 먼저 등록하여 save/load 완료를 확인
                const openChatChangedPromise = waitForChatChanged(5000);
                await freshContext.openCharacterChat(chatFileName);
                await openChatChangedPromise;
                
                // 🔥 FIX: 채팅이 실제로 전환되었는지 검증
                const verified = await waitFor(() => {
                    const ctx = api.getContext();
                    return ctx?.characters?.[ctx?.characterId]?.chat === chatFileName;
                }, 2000, 100);
                
                if (!verified) {
                    console.warn('[ChatHandlers] Chat mismatch after open, retrying once...');
                    const retryCtx = api.getContext();
                    const retryPromise = waitForChatChanged(5000);
                    await retryCtx.openCharacterChat(chatFileName);
                    await retryPromise;
                }
                
                console.debug('[ChatHandlers] Chat opened and verified');
                // 🔥 FIX: 채팅 전환 완료 후에만 Observer 시작
                finalizeLobbyClose();
                return;
            } catch (err) {
                console.warn('[ChatHandlers] context.openCharacterChat failed:', err);
            }
        }
        
        // Fallback: 채팅 선택 UI 클릭
        console.debug('[ChatHandlers] Using fallback method...');
        await openChatByFileName(fileName);
        // Fallback 경로에서도 전환 완료 후 Observer 시작
        finalizeLobbyClose();
        
    } catch (error) {
        console.error('[ChatHandlers] Failed to open chat:', error);
        showToast('채팅을 열지 못했습니다.', 'error');
        // 에러 시 UI가 숨겨진 상태라면 상태 정리
        if (lobbyHidden) {
            finalizeLobbyClose();
        }
    } finally {
        operationLock.release();
    }
}

/**
 * 파일명으로 채팅 열기 (UI 클릭 방식)
 * @param {string} fileName - 채팅 파일명
 * @returns {Promise<void>}
 */
async function openChatByFileName(fileName) {
    
    const manageChatsBtn = document.getElementById('option_select_chat');
    
    if (!manageChatsBtn) {
        console.error('[ChatHandlers] Chat select button not found');
        showToast('채팅 선택 버튼을 찾을 수 없습니다.', 'error');
        return;
    }
    
    manageChatsBtn.click();
    
    // 채팅 목록이 로드될 때까지 대기 (조건 확인 방식)
    const listLoaded = await waitFor(() => {
        return document.querySelectorAll('.select_chat_block').length > 0;
    }, 3000);
    
    if (!listLoaded) {
        console.error('[ChatHandlers] Chat list did not load');
        showToast('채팅 목록을 불러오지 못했습니다.', 'error');
        return;
    }
    
    // 파일명에서 확장자 제거하고 정규화
    const searchName = fileName.replace('.jsonl', '').trim();
    
    
    /**
     * 정확한 파일명 매칭
     */
    function isExactMatch(itemName, target) {
        const cleanItem = itemName.replace('.jsonl', '').trim();
        const cleanTarget = target.replace('.jsonl', '').trim();
        return cleanItem === cleanTarget;
    }
    
    // 채팅 목록에서 해당 파일 찾기
    const chatItems = document.querySelectorAll('.select_chat_block');
    
    for (const item of chatItems) {
        // file_name 속성에서 파일명 가져오기 (SillyTavern 표준)
        const itemFileName = item.getAttribute('file_name') || '';
        
        if (isExactMatch(itemFileName, searchName)) {
            
            // jQuery 클릭 (SillyTavern 방식)
            if (window.$) {
                window.$(item).trigger('click');
            } else {
                item.click();
            }
            
            return;
        }
    }
    
    console.warn('[ChatHandlers] ❌ Chat not found in list:', fileName);
    showToast('채팅 파일을 찾지 못했습니다.', 'warning');
}

// ============================================
// 채팅 삭제
// ============================================

/**
 * 채팅 삭제
 * @param {{ fileName: string, charAvatar: string, element: HTMLElement }} chatInfo
 * @returns {Promise<void>}
 */
export async function deleteChat(chatInfo) {
    const { fileName, charAvatar, element } = chatInfo;
    
    if (!fileName || !charAvatar) {
        console.error('[ChatHandlers] Missing chat data for delete');
        showToast('삭제할 채팅 정보가 없습니다.', 'error');
        return;
    }
    
    // 🔥 현재 열린 채팅인지 확인 (삭제 방지)
    const context = api.getContext();
    const currentChatFile = context?.characters?.[context?.characterId]?.chat;
    const fileNameWithoutExt = fileName.replace('.jsonl', '');
    
    if (currentChatFile === fileNameWithoutExt) {
        showToast('현재 열린 채팅은 삭제할 수 없습니다.\n다른 채팅으로 이동 후 삭제해주세요.', 'warning');
        return;
    }
    
    // 삭제 확인 (락 획득 전 — 대화상자 동안 락 점유 방지)
    const displayName = fileName.replace('.jsonl', '');
    const confirmed = await showConfirm(
        `"${displayName}" 채팅을 삭제하시겠습니까?\n\n이 작업은 되돌릴 수 없습니다.`,
        '채팅 삭제',
        true
    );
    
    if (!confirmed) return;
    
    // 확인 후 락 획득 (다른 채팅 작업과 동시 실행 방지)
    if (!operationLock.acquire('deleteChat')) {
        showToast('다른 작업이 진행 중입니다.', 'warning');
        return;
    }
    
    try {
        const success = await api.deleteChat(fileName, charAvatar);
        
        if (success) {
            // 로컬 데이터 정리
            const data = storage.load();
            const key = storage.getChatKey(charAvatar, fileName);
            delete data.chatAssignments[key];
            const favIndex = data.favorites.indexOf(key);
            if (favIndex > -1) {
                data.favorites.splice(favIndex, 1);
            }
            storage.save(data);
            
            // 캐시 무효화
            cache.invalidate('chats', charAvatar);
            
            // UI에서 해당 요소만 제거 (전체 리렌더 X)
            if (element) {
                element.style.transition = 'opacity 0.2s, transform 0.2s';
                element.style.opacity = '0';
                element.style.transform = 'translateX(20px)';
                setTimeout(() => {
                    if (element?.parentNode) {
                        element.remove();
                    }
                    updateChatCountAfterDelete();
                }, 200);
            }
            
            // 실리 동기화
            const context = api.getContext();
            if (context?.reloadCurrentChat) {
                try { 
                    await context.reloadCurrentChat(); 
                } catch(e) {
                    console.warn('[ChatLobby] reloadCurrentChat failed:', e);
                }
            }
            
            showToast('채팅이 삭제되었습니다.', 'success');
        } else {
            showToast('채팅 삭제에 실패했습니다.', 'error');
        }
    } catch (error) {
        console.error('[ChatHandlers] Error deleting chat:', error);
        showToast('채팅 삭제 중 오류가 발생했습니다.', 'error');
    } finally {
        operationLock.release();
    }
}

/**
 * 삭제 후 채팅 수 업데이트
 */
function updateChatCountAfterDelete() {
    const remaining = document.querySelectorAll('.lobby-chat-item').length;
    const countEl = document.getElementById('chat-panel-count');
    
    if (countEl) {
        countEl.textContent = remaining > 0 ? `${remaining}개 채팅` : '채팅 없음';
    }
    
    if (remaining === 0) {
        const chatsList = document.getElementById('chat-lobby-chats-list');
        if (chatsList) {
            chatsList.innerHTML = `
                <div class="lobby-empty-state" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;color:var(--text-muted,#888);padding:40px;">
                    <i>💬</i>
                    <div>채팅 기록이 없습니다</div>
                </div>
            `;
        }
    }
}

// ============================================
// 새 채팅 시작
// ============================================

/**
 * 새 채팅 시작 (캐릭터 또는 그룹)
 * @returns {Promise<void>}
 */
export async function startNewChat() {
    if (!operationLock.acquire('startNewChat')) return;
    
    try {
        const btn = document.getElementById('chat-lobby-new-chat');
        
        // 그룹인지 캐릭터인지 확인
        const isGroup = btn?.dataset.isGroup === 'true';
        
        if (isGroup) {
            await startNewGroupChat(btn);
        } else {
            await startNewCharacterChat(btn);
        }
    } finally {
        operationLock.release();
    }
}

/**
 * 캐릭터 새 채팅 시작
 * @param {HTMLElement} btn - 새 채팅 버튼
 * @returns {Promise<void>}
 */
async function startNewCharacterChat(btn) {
    const charIndex = btn?.dataset.charIndex;
    const charAvatar = btn?.dataset.charAvatar;
    
    // NaN 처리 포함한 유효성 검사
    const charIndexNum = parseInt(charIndex, 10);
    if (!charAvatar || isNaN(charIndexNum) || charIndexNum < 0) {
        console.error('[ChatHandlers] No character selected or invalid index');
        showToast('캐릭터가 선택되지 않았습니다.', 'error');
        return;
    }
    
    // 🔥 채팅 수를 직접 확인 (dataset은 비동기 로딩으로 인해 신뢰할 수 없음)
    let actualChatCount = 0;
    try {
        const chats = await api.fetchChatsForCharacter(charAvatar);
        actualChatCount = Array.isArray(chats) ? chats.length : 0;
        console.debug('[ChatHandlers] Actual chat count:', actualChatCount);
    } catch (e) {
        console.warn('[ChatHandlers] Failed to get chat count, using dataset fallback');
        actualChatCount = btn?.dataset.hasChats === 'true' ? 1 : 0;
    }
    
    try {
        // 캐시 무효화
        cache.invalidate('chats', charAvatar);
        
        // 이미 같은 캐릭터가 선택되어 있는지 확인
        const context = api.getContext();
        const currentChar = context?.characters?.[context.characterId];
        const isSameCharacter = currentChar?.avatar === charAvatar;
        
        if (!isSameCharacter) {
            // 다른 캐릭터인 경우에만 selectCharacterById 호출
            // ⚠️ 리스너 먼저 등록 → 그 다음 호출
            const chatChangedPromise = waitForChatChanged(5000);
            await api.selectCharacterById(charIndexNum);
            
            // CHAT_CHANGED 이벤트 대기 (ST의 save/load 완료 확인)
            const chatChanged = await chatChangedPromise;
            if (!chatChanged) {
                await waitForCharacterSelect(charAvatar, 2000);
            }
            
            // 🔥 FIX: 300ms 하드코딩 → 상태 폴링 검증
            const stateReady = await waitFor(() => {
                const ctx = api.getContext();
                const cur = ctx?.characters?.[ctx?.characterId];
                return cur?.avatar === charAvatar;
            }, 3000, 100);
            
            if (!stateReady) {
                console.warn('[ChatHandlers] Character state not ready for new chat');
                await new Promise(r => setTimeout(r, 500));
            }
        }
        
        // 🔥 FIX: 로비 닫기를 캐릭터 전환 완료 후로 이동 (Observer 간섭 방지)
        // UI 숨기기 → 새 채팅 클릭 → 상태 정리 순서
        hideLobbyUI();
        
        // 🔥 채팅 기록이 있는 경우에만 새 채팅 버튼 클릭
        // 채팅이 0개면 SillyTavern이 자동으로 첫 채팅을 생성하므로 추가 동작 불필요
        if (actualChatCount > 0) {
            const newChatBtn = await waitForElement('#option_start_new_chat', 1000);
            if (newChatBtn) newChatBtn.click();
        }
        
        // 🔥 FIX: 새 채팅 시작 후에 Observer 시작
        finalizeLobbyClose();
    } catch (error) {
        console.error('[ChatHandlers] Failed to start new chat:', error);
        showToast('새 채팅을 시작하지 못했습니다.', 'error');
        // 에러 시에도 상태 정리
        finalizeLobbyClose();
    }
}

/**
 * 그룹 새 채팅 시작
 * @param {HTMLElement} btn - 새 채팅 버튼
 * @returns {Promise<void>}
 */
async function startNewGroupChat(btn) {
    const groupId = btn?.dataset.groupId;
    const groupName = btn?.dataset.groupName;
    
    if (!groupId) {
        console.error('[ChatHandlers] No group selected');
        showToast('그룹이 선택되지 않았습니다.', 'error');
        return;
    }
    
    console.debug('[ChatHandlers] Starting new group chat:', { groupId, groupName });
    
    try {
        // 1. 그룹 선택 (UI 클릭 방식 - 정확한 선택자 사용)
        const groupCard = document.querySelector(`.group_select[data-grid="${groupId}"]`);
        
        if (!groupCard) {
            console.error('[ChatHandlers] Group card not found:', groupId);
            showToast('그룹을 찾을 수 없습니다.', 'error');
            return;
        }
        
        console.debug('[ChatHandlers] Found group card, clicking...');
        if (window.$) {
            window.$(groupCard).trigger('click');
        } else {
            groupCard.click();
        }
        
        // 2. 그룹 선택 완료 대기 (CHAT_CHANGED 또는 fallback 딜레이)
        const groupChatChanged = waitForChatChanged(3000);
        const groupChanged = await groupChatChanged;
        if (!groupChanged) {
            // 이벤트 못 받으면 fallback 딜레이
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // 3. 🔥 FIX: UI만 먼저 숨기기 (Observer 간섭 방지)
        hideLobbyUI();
        
        // 4. 새 채팅 버튼 클릭
        const newChatBtn = await waitForElement('#option_start_new_chat', 1000);
        if (newChatBtn) {
            console.debug('[ChatHandlers] Clicking new chat button');
            newChatBtn.click();
        } else {
            console.error('[ChatHandlers] New chat button not found');
            showToast('새 채팅 버튼을 찾을 수 없습니다.', 'error');
        }
        
        // 5. 🔥 FIX: 작업 완료 후 상태 정리 + Observer 시작
        finalizeLobbyClose();
        
    } catch (error) {
        console.error('[ChatHandlers] Failed to start new group chat:', error);
        showToast('그룹 새 채팅을 시작하지 못했습니다.', 'error');
        finalizeLobbyClose();
    }
}

// ============================================
// 캐릭터 삭제
// ============================================

/**
 * 캐릭터 삭제 (SillyTavern 내장 함수 사용)
 * @returns {Promise<void>}
 */
export async function deleteCharacter() {
    // store 대신 버튼의 dataset에서 직접 가져오기 (레이스컨디션 방지)
    const deleteBtn = document.getElementById('chat-lobby-delete-char');
    const charAvatar = deleteBtn?.dataset.charAvatar;
    const charName = deleteBtn?.dataset.charName;
    
    if (!charAvatar) {
        showToast('삭제할 캐릭터가 선택되지 않았습니다.', 'error');
        return;
    }
    
    // context에서 실제 캐릭터 객체 확인 (최신 상태)
    const context = api.getContext();
    const char = context?.characters?.find(c => c.avatar === charAvatar);
    
    if (!char) {
        showToast('캐릭터를 찾을 수 없습니다. 이미 삭제되었을 수 있어요.', 'error');
        closeChatPanel();
        return;
    }
    
    // 사용자 확인 (락 획득 전)
    const confirmed = await showConfirm(
        `"${char.name}" 캐릭터와 모든 채팅을 삭제하시겠습니까?\n\n이 작업은 되돌릴 수 없습니다.`
    );
    
    if (!confirmed) {
        return;
    }
    
    // 확인 후 락 획득
    if (!operationLock.acquire('deleteCharacter')) {
        showToast('다른 작업이 진행 중입니다.', 'warning');
        return;
    }
    
    try {
        // 로비 데이터 먼저 정리
        const data = storage.load();
        const prefix = char.avatar + '::';
        
        Object.keys(data.chatAssignments).forEach(key => {
            if (key.startsWith(prefix)) {
                delete data.chatAssignments[key];
            }
        });
        
        data.favorites = data.favorites.filter(key => !key.startsWith(prefix));
        storage.save(data);
        
        // UI 리셋
        closeChatPanel();
        
        // SillyTavern 내장 deleteCharacter 함수 사용 시도
        // (위에서 가져온 context 재사용 - 레이스 컨디션 방지)
        if (typeof context?.deleteCharacter === 'function') {
            // SillyTavern 내장 함수 사용 (context.characters 자동 갱신됨)
            await context.deleteCharacter(char.avatar, { deleteChats: true });
        } else {
            // Fallback: 직접 API 호출 후 getCharacters로 갱신
            const headers = api.getRequestHeaders();
            const avatarUrl = char.avatar.endsWith('.png') ? char.avatar : `${char.avatar}.png`;
            
            const response = await fetch('/api/characters/delete', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    avatar_url: avatarUrl,
                    delete_chats: true
                })
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('[ChatLobby] Delete response:', response.status, errorText);
                throw new Error(`Delete failed: ${response.status} - ${errorText}`);
            }
            
            // API 삭제 성공 후 SillyTavern의 characters 배열 갱신
            if (typeof context?.getCharacters === 'function') {
                await context.getCharacters();
            }
        }
        
        // 캐시 무효화
        cache.invalidate('characters');
        cache.invalidate('chats', char.avatar);
        
        showToast(`"${char.name}" 캐릭터가 삭제되었습니다.`, 'success');
        
        // 그리드 새로고침 (로비가 열려있으면)
        const overlay = document.getElementById('chat-lobby-overlay');
        if (overlay?.style.display === 'flex') {
            // 이벤트로 순환 참조 방지
            window.dispatchEvent(new CustomEvent('chatlobby:refresh-grid'));
        }
        
    } catch (error) {
        console.error('[ChatHandlers] Failed to delete character:', error);
        showToast('캐릭터 삭제 중 오류가 발생했습니다.', 'error');
    } finally {
        operationLock.release();
    }
}

// ============================================
// 헬퍼 함수
// ============================================

/**
 * 로비 UI만 숨기기 (DOM Observer는 시작하지 않음)
 * 채팅 전환 중에 사용 — Observer가 DOM 변경에 반응하여
 * 캐시를 오염시키는 것을 방지
 */
function hideLobbyUI() {
    const overlay = document.getElementById('chat-lobby-overlay');
    const container = document.getElementById('chat-lobby-container');
    const fab = document.getElementById('chat-lobby-fab');
    
    if (overlay) overlay.style.display = 'none';
    if (container) container.style.display = 'none';
    if (fab) fab.style.display = 'flex';
    
    // CustomTheme 사이드바 버튼 상태 초기화
    const sidebarBtn = document.getElementById('st-chatlobby-sidebar-btn');
    if (sidebarBtn) {
        const icon = sidebarBtn.querySelector('.drawer-icon');
        icon?.classList.remove('openIcon');
        icon?.classList.add('closedIcon');
    }
}

/**
 * 채팅 전환 완료 후 상태 정리
 * hideLobbyUI() 후 채팅 전환이 끝나면 호출하여
 * store 상태를 갱신하고 DOM Observer를 시작한다.
 */
function finalizeLobbyClose() {
    store.setLobbyOpen(false);
    closeChatPanel();
    // 주의: store.reset()을 호출하지 않음 - 상태 유지
    // 🔥 채팅 전환이 완전히 끝난 후에만 DOM Observer 시작
    startRecentDomObserver();
}

/**
 * 로비 닫기 (상태 유지) — 편의 래퍼
 * 채팅 전환 없이 단순히 로비를 닫을 때 사용
 * 채팅 전환이 필요한 경우에는 hideLobbyUI() → 전환 → finalizeLobbyClose() 패턴 사용
 */
function closeLobbyKeepState() {
    hideLobbyUI();
    finalizeLobbyClose();
}
