import { CONFIG } from '../config.js';
import { cache } from '../data/cache.js';
import { api } from '../api/sillyTavern.js';
import { store } from '../data/store.js';
import { renderPersonaBar } from '../ui/personaBar.js';
import { renderCharacterGrid } from '../ui/characterGrid.js';
import { showToast } from '../ui/notifications.js';
import { intervalManager } from '../utils/intervalManager.js';
import { openDrawerSafely } from '../utils/drawerHelper.js';
import { waitForElement, waitForCharacterSelect } from '../utils/waitFor.js';
import { isLobbyOpen, closeLobby } from '../ui/lobbyManager.js';

/**
 * 새로고침 처리 - 캐시 완전 무효화 후 강제 리로드
 */
export async function handleRefresh() {
    cache.invalidateAll();
    
    // 강제로 API 재호출 (forceRefresh=true)
    await api.fetchPersonas();
    await api.fetchCharacters(true);
    
    await renderPersonaBar();
    await renderCharacterGrid();
    
    showToast('새로고침 완료', 'success');
}

/**
 * 캐릭터 임포트 처리
 * 로비를 닫지 않고 임포트 버튼만 클릭
 * 캐릭터 수 변화 감지하여 직접 리렌더
 */
export function handleImportCharacter() {
    const importBtn = document.getElementById('character_import_button');
    if (!importBtn) return;
    
    // 현재 캐릭터 아바타 목록 저장 (숫자만 비교 X)
    const beforeAvatars = new Set(
        api.getCharacters().map(c => c.avatar)
    );
    
    importBtn.click();
    
    let attempts = 0;
    const maxAttempts = 10; // 5초 (500ms * 10)
    
    const checkInterval = intervalManager.set(async () => {
        attempts++;
        
        const currentChars = api.getCharacters();
        // 새로운 아바타가 있는지 확인 (더 정확함)
        const newChar = currentChars.find(c => !beforeAvatars.has(c.avatar));
        
        if (newChar) {
            intervalManager.clear(checkInterval);
            cache.invalidate('characters');
            if (isLobbyOpen()) {
                await renderCharacterGrid(store.searchTerm);
            }
            showToast(`"${newChar.name}" 캐릭터가 추가되었습니다!`, 'success');
            return;
        }
        
        // 타임아웃
        if (attempts >= maxAttempts) {
            intervalManager.clear(checkInterval);
            // 사용자에게 알리지 않음 (취소했을 수도 있으니까)
        }
    }, 500);
}

/**
 * 페르소나 추가 처리
 * 드로어 열어서 더미 페르소나 만들기
 * 사용자가 이름 입력 후 확인하면 드로어가 닫히므로 그때 리렌더
 */
export async function handleAddPersona() {
    // 드로어 열기 (CustomTheme 호환 - 클릭 대신 클래스 조작)
    if (!openDrawerSafely('persona-management-button')) {
        showToast('페르소나 관리를 열 수 없습니다.', 'error');
        return;
    }
    
    // 버튼이 나타날 때까지 대기
    const createBtn = await waitForElement('#create_dummy_persona', 2000);
    if (createBtn) {
        createBtn.click();
        cache.invalidate('personas');
        
        // 페르소나 드로어가 닫힐 때까지 감시 (최대 30초)
        // intervalManager 사용
        let checkCount = 0;
        const maxChecks = 60; // 500ms * 60 = 30초
        
        const checkDrawerClosed = intervalManager.set(() => {
            checkCount++;
            const drawer = document.getElementById('persona-management-button');
            const isOpen = drawer?.classList.contains('openDrawer') || 
                           drawer?.querySelector('.drawer-icon.openIcon');
            
            
            if (!isOpen || checkCount >= maxChecks) {
                intervalManager.clear(checkDrawerClosed);
                
                if (checkCount >= maxChecks) {
                } else {
                }
                
                cache.invalidate('personas');
                if (isLobbyOpen()) {
                    renderPersonaBar();
                }
            }
        }, 500);
    } else {
        showToast('페르소나 생성 버튼을 찾을 수 없습니다', 'error');
    }
}

/**
 * 선택된 캐릭터 편집 화면으로 이동 (봇카드 관리 화면)
 */
export async function handleGoToCharacter() {
    const character = store.currentCharacter;
    if (!character) {
        console.warn('[ChatLobby] No character selected');
        return;
    }
    
    
    // 캐릭터 선택
    const context = api.getContext();
    const characters = context?.characters || [];
    const index = characters.findIndex(c => c.avatar === character.avatar);
    
    if (index === -1) {
        console.error('[ChatLobby] Character not found:', character.avatar);
        return;
    }
    
    // 로비 닫기 (상태 초기화)
    closeLobby();
    
    // 이미 선택된 캐릭터인지 확인
    const isAlreadySelected = (context.characterId === index);
    
    if (!isAlreadySelected) {
        // 다른 캐릭터면 선택 먼저
        await api.selectCharacterById(index);
        
        // 캐릭터 선택 완료 대기 (조건 확인 방식)
        const charSelected = await waitForCharacterSelect(character.avatar, 2000);
        if (!charSelected) {
            console.warn('[ChatLobby] Character selection timeout');
        }
    }
    
    // 바로 드로어 열기 (CustomTheme 호환 - 클릭 대신 클래스 조작)
    if (!openDrawerSafely('rightNavHolder')) {
        // fallback: rightNavDrawerIcon 클릭 시도
        const rightNavIcon = document.getElementById('rightNavDrawerIcon');
        if (rightNavIcon) {
            rightNavIcon.click();
        } else {
            console.warn('[ChatLobby] Could not open character drawer');
        }
    }
}
