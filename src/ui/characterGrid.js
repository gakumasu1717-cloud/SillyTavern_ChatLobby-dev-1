// ============================================
// 캐릭터 그리드 UI
// ============================================

import { api } from '../api/sillyTavern.js';
import { cache } from '../data/cache.js';
import { storage } from '../data/storage.js';
import { store } from '../data/store.js';
import { lastChatCache } from '../data/lastChatCache.js';
import { saveSnapshot, getLocalDateString, loadSnapshots } from '../data/calendarStorage.js';
import { escapeHtml } from '../utils/textUtils.js';
import { debounce } from '../utils/eventHelpers.js';
import { showToast } from './notifications.js';
import { closeChatPanel } from './chatList.js';
import { CONFIG } from '../config.js';

// 렌더링 중복 방지
let isRendering = false;
let pendingRender = null;
let renderDebounceTimer = null;

// 캐릭터 선택 중복 방지 (전역)
let isSelectingCharacter = false;

// 그룹 포함 여부 (이벤트 바인딩 시 필요)
let hasGroups = false;

// ============================================
// 이벤트 위임 (Event Delegation)
// O(N) 개별 리스너 → O(1) 컨테이너 리스너
// ============================================
let delegatedGridContainer = null;
let delegatedTagContainer = null;
const SCROLL_THRESHOLD = 10;
const DELEGATION_COOLDOWN = 300;
let lastDelegatedClickTime = 0;

// 단일 터치 상태 (한 번에 하나의 터치만 처리)
const gridTouch = { startX: 0, startY: 0, isScrolling: false, handled: false };
const tagTouch = { startX: 0, startY: 0, isScrolling: false, handled: false };

/**
 * 캐릭터 선택 플래그 리셋 (로비 열 때 호출)
 */
export function resetCharacterSelectLock() {
    isSelectingCharacter = false;
}

// ============================================
// 초기화
// ============================================

/**
 * 캐릭터 선택 핸들러 설정
 * @param {Function} handler - 캐릭터 선택 시 호출되는 콜백
 */
export function setCharacterSelectHandler(handler) {
    store.setCharacterSelectHandler(handler);
}

/**
 * 그룹 선택 핸들러 설정
 * @param {Function} handler - 그룹 선택 시 호출되는 콜백
 */
export function setGroupSelectHandler(handler) {
    store.setGroupSelectHandler(handler);
}

// ============================================
// 캐릭터 그리드 렌더링
// ============================================

/**
 * 캐릭터 그리드 렌더링
 * context.characters를 직접 사용 (항상 최신 데이터)
 * @param {string} [searchTerm=''] - 검색어
 * @param {string|null} [sortOverride=null] - 정렬 옵션 오버라이드
 * @returns {Promise<void>}
 */
export async function renderCharacterGrid(searchTerm = '', sortOverride = null) {
    // Debounce: 100ms 내 중복 호출 무시
    if (renderDebounceTimer) {
        clearTimeout(renderDebounceTimer);
    }
    
    return new Promise((resolve) => {
        renderDebounceTimer = setTimeout(async () => {
            renderDebounceTimer = null;
            await _doRenderCharacterGrid(searchTerm, sortOverride);
            resolve();
        }, 100);
    });
}

/**
 * 실제 캐릭터 그리드 렌더링 (debounce 후 호출)
 */
async function _doRenderCharacterGrid(searchTerm = '', sortOverride = null) {
    // 렌더링 중복 방지
    if (isRendering) {
        pendingRender = { searchTerm, sortOverride };
        return;
    }
    
    isRendering = true;
    // 락은 openLobby/캐릭터클릭에서 관리 (여기서 설정 안 함)
    
    try {
        const container = document.getElementById('chat-lobby-characters');
        if (!container) return;
        
        // 검색어 저장
        store.setSearchTerm(searchTerm);
        
        // context에서 직접 캐릭터 가져오기 (항상 최신)
        const characters = api.getCharacters();
        
        if (characters.length === 0) {
            container.innerHTML = `
                <div class="lobby-empty-state">
                    <i>👥</i>
                    <div>캐릭터가 없습니다</div>
                    <button data-action="refresh" style="margin-top:10px;padding:8px 16px;cursor:pointer;">새로고침</button>
                </div>
            `;
            return;
        }
        
        await renderCharacterList(container, characters, searchTerm, sortOverride);
    } finally {
        isRendering = false;
        // 락 해제는 openLobby/캐릭터클릭에서 관리
        
        // 대기 중인 렌더 있으면 실행
        if (pendingRender) {
            const { searchTerm: s, sortOverride: o } = pendingRender;
            pendingRender = null;
            renderCharacterGrid(s, o);
        }
    }
}

/**
 * 캐릭터 목록 렌더링 (내부) - 그룹 포함
 * @param {HTMLElement} container - 컨테이너 요소
 * @param {Array} characters - 캐릭터 배열
 * @param {string} searchTerm - 검색어
 * @param {string|null} sortOverride - 정렬 오버라이드
 * @returns {Promise<void>}
 */
async function renderCharacterList(container, characters, searchTerm, sortOverride) {
    let filtered = [...characters];
    
    // 검색 필터
    if (searchTerm) {
        const term = searchTerm.toLowerCase();
        filtered = filtered.filter(char =>
            (char.name || '').toLowerCase().includes(term)
        );
    }
    
    // 태그 필터 (AND 조건 - 검색과 함께 적용)
    const selectedTag = store.selectedTag;
    if (selectedTag) {
        filtered = filtered.filter(char => {
            const charTags = getCharacterTags(char);
            return charTags.includes(selectedTag);
        });
    }
    
    // 태그바 렌더링 (필터 전 전체 캐릭터 기준으로 집계)
    renderTagBar(characters);
    
    // 정렬 옵션
    const sortOption = sortOverride || storage.getCharSortOption();
    
    // 드롭다운 동기화
    const sortSelect = document.getElementById('chat-lobby-char-sort');
    if (sortSelect && sortSelect.value !== sortOption) {
        sortSelect.value = sortOption;
    }
    
    // 그룹 가져오기 (검색 필터 적용)
    let groups = [];
    try {
        groups = await api.getGroups();
        
        if (searchTerm) {
            const term = searchTerm.toLowerCase();
            groups = groups.filter(g => (g.name || '').toLowerCase().includes(term));
        }
        // 태그 필터가 있으면 그룹은 제외 (그룹은 태그 없음)
        if (selectedTag) {
            groups = [];
        }
    } catch (e) {
        console.warn('[CharacterGrid] Failed to load groups:', e);
    }
    
    if (filtered.length === 0 && groups.length === 0) {
        container.innerHTML = `
            <div class="lobby-empty-state">
                <i>🔍</i>
                <div>검색 결과가 없습니다</div>
            </div>
        `;
        return;
    }
    
    // 원본 인덱스 보존 (context.characters 기준) - avatar로 O(1) 룩업
    const originalCharacters = api.getCharacters();
    const indexMap = new Map(originalCharacters.map((c, i) => [c.avatar, i]));
    
    // ★ 캐릭터와 그룹을 통합 배열로 만들어서 함께 정렬
    const allItems = [
        ...filtered.map(char => ({ type: 'character', data: char })),
        ...groups.map(group => ({ type: 'group', data: group }))
    ];
    
    // 통합 정렬
    const sortedItems = await sortCharactersAndGroups(allItems, sortOption);
    
    // 그룹 포함 여부 저장 (이벤트 바인딩용)
    hasGroups = groups.length > 0;
    
    // ★ 일반 렌더링 (VirtualScroller 제거)
    const html = sortedItems.map((item, index) => {
        if (item.type === 'character') {
            return renderCharacterCard(item.data, indexMap.get(item.data.avatar), sortOption);
        } else {
            return renderGroupCard(item.data, sortOption);
        }
    }).join('');
    
    container.innerHTML = html;
    
    // 이벤트 위임 설정 (최초 1회만 리스너 등록, 이후 no-op)
    setupGridDelegation(container);
    
    // 선택 상태 복원
    restoreSelectedState(container);
    
    // 백그라운드에서 채팅 수 로딩 후 UI 업데이트
    loadChatCountsAsync(filtered, sortOption);
}

/**
 * 캐릭터 카드 HTML 생성 - 넷플릭스 스타일 + 호버 정보
 * @param {Object} char - 캐릭터 객체
 * @param {number} index - 원본 인덱스
 * @param {string} sortOption - 정렬 옵션
 * @returns {string}
 */
function renderCharacterCard(char, index, sortOption = 'recent') {
    const avatarUrl = char.avatar ? `/characters/${encodeURIComponent(char.avatar)}` : '/img/ai4.png';
    const name = char.name || 'Unknown';
    const safeAvatar = escapeHtml(char.avatar || '');
    
    const isFav = isFavoriteChar(char);
    
    // 최근 채팅순 정렬 + 오늘 날짜인 경우에만 시간 표시
    let lastChatTimeStr = '';
    if (sortOption === 'recent') {
        const lastChatTime = lastChatCache.getForSort(char);
        if (lastChatTime > 0) {
            const now = new Date();
            const lastDate = new Date(lastChatTime);
            const isToday = now.toDateString() === lastDate.toDateString();
            
            if (isToday) {
                const hours = lastDate.getHours();
                const minutes = String(lastDate.getMinutes()).padStart(2, '0');
                lastChatTimeStr = `${hours}:${minutes}`;
            }
        }
    }
    
    // 채팅 수 (캐시에서 가져오기, 없으면 API 응답 필드 사용)
    const cachedChatCount = cache.get('chatCounts', char.avatar);
    // 메시지 수 (chat_items 합계)
    const cachedMessageCount = cache.get('messageCounts', char.avatar);
    
    // null/undefined가 아닌 숫자인지 확인
    const hasCount = typeof cachedChatCount === 'number';
    const hasMessageCount = typeof cachedMessageCount === 'number';
    
    const chatCountText = hasCount 
        ? (cachedChatCount > 0 ? `${cachedChatCount}개 채팅` : '채팅 없음')
        : '로딩 중...';
    const messageCountText = hasMessageCount
        ? (cachedMessageCount > 0 ? `${cachedMessageCount}개 메시지` : '')
        : '';
    
    // 즐겨찾기 버튼
    const favBtn = `<button class="char-fav-btn" data-char-avatar="${safeAvatar}" title="즐겨찾기 토글">${isFav ? '★' : '☆'}</button>`;
    
    return `
    <div class="lobby-char-card ${isFav ? 'is-char-fav' : ''}" 
         data-char-index="${index}" 
         data-char-avatar="${safeAvatar}" 
         data-char-name="${escapeHtml(name)}"
         data-is-fav="${isFav}"
         draggable="false">
        ${favBtn}
        <img class="lobby-char-avatar" 
             src="${avatarUrl}" 
             alt="${escapeHtml(name)}" 
             loading="lazy"
             draggable="false"
             data-fallback="avatar">
        <div class="lobby-char-name">
            <span class="char-name-text">${escapeHtml(name)}${lastChatTimeStr ? ` <span class="char-last-time">${lastChatTimeStr}</span>` : ''}</span>
            <div class="char-hover-info">
                <div class="info-row">
                    <span class="info-icon">💬</span>
                    <span class="info-value chat-count-value">${chatCountText}</span>
                </div>
                ${messageCountText ? `
                <div class="info-row">
                    <span class="info-icon">📝</span>
                    <span class="info-value message-count-value">${messageCountText}</span>
                </div>
                ` : ''}
            </div>
        </div>
    </div>
    `;
}

/**
 * 백그라운드에서 채팅 수 로딩 후 UI 업데이트
 * 배치 처리로 메모리 최적화 + 메인 스레드 블로킹 방지
 * @param {Array} characters - 캐릭터 배열
 * @param {string} sortOption - 정렬 옵션
 */
async function loadChatCountsAsync(characters, sortOption = 'recent') {
    const BATCH_SIZE = 5;
    
    // 카드 요소 미리 매핑 — O(N) querySelector 반복 → O(1) Map 조회
    const charContainer = document.getElementById('chat-lobby-characters');
    const cardMap = new Map();
    if (charContainer) {
        charContainer.querySelectorAll('.lobby-char-card[data-char-avatar]').forEach(card => {
            cardMap.set(card.dataset.charAvatar, card);
        });
    }
    
    for (let i = 0; i < characters.length; i += BATCH_SIZE) {
        const batch = characters.slice(i, i + BATCH_SIZE);
        
        await Promise.allSettled(batch.map(async (char) => {
            // 이미 캐시에 숫자가 있으면 스킵
            const existingCount = cache.get('chatCounts', char.avatar);
            if (typeof existingCount === 'number') return;
            
            try {
                const chats = await api.fetchChatsForCharacter(char.avatar);
                // API 응답이 배열인지 확인 (객체일 수도 있음)
                const chatArray = Array.isArray(chats) ? chats : (typeof chats === 'object' && chats ? Object.values(chats) : []);
                const count = chatArray.length;
                
                // 메시지 수 합계 (chat_items 합산)
                const messageCount = chatArray.reduce((sum, chat) => {
                    return sum + (chat.chat_items || 0);
                }, 0);
                
                cache.set('chatCounts', count, char.avatar);
                cache.set('messageCounts', messageCount, char.avatar);
                
                // DOM 업데이트 (Map O(1) 조회)
                const card = cardMap.get(char.avatar);
                
                // ★ lastChatCache에도 마지막 채팅 시간 갱신 (재접속 정렬 정확도 향상)
                if (chatArray.length > 0) {
                    await lastChatCache.refreshForCharacter(char.avatar, chatArray);
                    
                    // 최근 채팅순 정렬 + 오늘 날짜인 경우에만 시간 표시
                    if (sortOption === 'recent' && card) {
                        const lastTime = lastChatCache.get(char.avatar);
                        if (lastTime > 0) {
                            // 오늘 날짜인지 확인
                            const now = new Date();
                            const lastDate = new Date(lastTime);
                            const isToday = now.toDateString() === lastDate.toDateString();
                            
                            if (isToday) {
                                const nameTextEl = card.querySelector('.char-name-text');
                                if (nameTextEl && !nameTextEl.querySelector('.char-last-time')) {
                                    const hours = lastDate.getHours();
                                    const minutes = String(lastDate.getMinutes()).padStart(2, '0');
                                    const timeSpan = document.createElement('span');
                                    timeSpan.className = 'char-last-time';
                                    timeSpan.textContent = ` ${hours}:${minutes}`;
                                    nameTextEl.appendChild(timeSpan);
                                }
                            }
                        }
                    }
                }
                
                if (card) {
                    const chatValueEl = card.querySelector('.chat-count-value');
                    if (chatValueEl) {
                        chatValueEl.textContent = count > 0 ? `${count}개 채팅` : '채팅 없음';
                    }
                    
                    // 메시지 수 업데이트 (요소가 없으면 추가)
                    const hoverInfo = card.querySelector('.char-hover-info');
                    if (hoverInfo && messageCount > 0) {
                        let messageRow = hoverInfo.querySelector('.message-count-value');
                        if (!messageRow) {
                            const newRow = document.createElement('div');
                            newRow.className = 'info-row';
                            newRow.innerHTML = `
                                <span class="info-icon">📝</span>
                                <span class="info-value message-count-value">${messageCount}개 메시지</span>
                            `;
                            hoverInfo.appendChild(newRow);
                        } else {
                            messageRow.textContent = `${messageCount}개 메시지`;
                        }
                    }
                }
            } catch (e) {
                console.error('[CharacterGrid] Failed to load chat count:', char.name, e);
            }
        }));
        
        // 배치 간 약간의 딜레이로 메인 스레드 블로킹 방지 + GC 기회 제공
        if (i + BATCH_SIZE < characters.length) {
            await new Promise(r => setTimeout(r, 10));
        }
    }
    
    // 🔥 로비 로드 완료 후 오늘 스냅샷 저장 (캐시 재사용, API 호출 0)
    await saveTodaySnapshotFromCache();
}

/**
 * 🔥 캐시에서 오늘 스냅샷 저장 (필요시 API fallback)
 * loadChatCountsAsync 완료 후 호출됨
 */
async function saveTodaySnapshotFromCache() {
    try {
        const today = getLocalDateString();
        const characters = api.getCharacters();
        
        if (!characters || characters.length === 0) return;
        
        // 캐시에서 데이터 수집
        const byChar = {};
        let totalMessages = 0;
        
        characters.forEach(char => {
            const msgCount = cache.get('messageCounts', char.avatar) || 0;
            if (msgCount > 0) {
                byChar[char.avatar] = msgCount;
                totalMessages += msgCount;
            }
        });
        
        // lastChatTimes - 오늘 날짜만
        const lastChatTimes = {};
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayStartMs = todayStart.getTime();
        
        // 타임스탬프 0인 캐릭터는 API fallback으로 가져오기
        await Promise.allSettled(characters.map(async (char) => {
            let lastTime = lastChatCache.get(char.avatar);
            
            // 캐시에 없으면 refreshForCharacter로 API fallback 시도
            if (lastTime === 0) {
                lastTime = await lastChatCache.refreshForCharacter(char.avatar);
            }
            
            if (lastTime >= todayStartMs) {
                lastChatTimes[char.avatar] = lastTime;
            }
        }));
        
        // 가장 증가한 캐릭터 찾기 (이전 스냅샷과 비교)
        const snapshots = loadSnapshots();
        let topChar = '';
        let maxIncrease = -Infinity;
        
        // 최근 스냅샷 찾기 (오늘 제외)
        let recentSnapshot = null;
        const checkDate = new Date();
        for (let i = 0; i < 7; i++) {
            checkDate.setDate(checkDate.getDate() - 1);
            const dateStr = getLocalDateString(checkDate);
            if (snapshots[dateStr]) {
                recentSnapshot = snapshots[dateStr];
                break;
            }
        }
        
        const baseByChar = recentSnapshot?.byChar || {};
        
        for (const [avatar, msgCount] of Object.entries(byChar)) {
            const prev = baseByChar[avatar] || 0;
            const increase = msgCount - prev;
            if (increase > maxIncrease) {
                maxIncrease = increase;
                topChar = avatar;
            }
        }
        
        // 기준 없으면 메시지 1위
        if (!topChar) {
            const sorted = Object.entries(byChar).sort((a, b) => b[1] - a[1]);
            topChar = sorted[0]?.[0] || '';
        }
        
        saveSnapshot(today, totalMessages, topChar, byChar, lastChatTimes);
        console.debug('[CharacterGrid] Snapshot saved from cache');
        
    } catch (e) {
        console.error('[CharacterGrid] Failed to save snapshot:', e);
    }
}

/**
 * 캐릭터가 즐겨찾기인지 확인 (로컬 스토리지 기준)
 * @param {Object} char - 캐릭터 객체
 * @returns {boolean}
 */
function isFavoriteChar(char) {
    // 로컬 스토리지에서 확인 (SillyTavern API 안 쓰는 독립 방식)
    return storage.isCharacterFavorite(char.avatar);
}

/**
 * 현재 선택된 캐릭터/그룹의 .selected 클래스 복원
 * VirtualScroller 렌더링 후 호출됨
 * @param {HTMLElement} container - 컨테이너 요소
 */
function restoreSelectedState(container) {
    // 현재 선택된 캐릭터가 있으면 .selected 클래스 복원
    const currentChar = store.currentCharacter;
    if (currentChar?.avatar) {
        const selectedCard = container.querySelector(`.lobby-char-card[data-char-avatar="${CSS.escape(currentChar.avatar)}"]`);
        if (selectedCard) {
            selectedCard.classList.add('selected');
        }
    }
    
    // 현재 선택된 그룹이 있으면 .selected 클래스 복원
    const currentGroup = store.currentGroup;
    if (currentGroup?.id) {
        const selectedCard = container.querySelector(`.lobby-group-card[data-group-id="${CSS.escape(currentGroup.id)}"]`);
        if (selectedCard) {
            selectedCard.classList.add('selected');
        }
    }
}

/**
 * 캐릭터와 그룹 통합 정렬
 * @param {Array} items - { type: 'character' | 'group', data: object }[]
 * @param {string} sortOption - 정렬 옵션 ('recent', 'name', 'chats')
 * @returns {Promise<Array>}
 */
async function sortCharactersAndGroups(items, sortOption) {
    
    if (sortOption === 'chats') {
        // 메시지 수 정렬 - 캐릭터는 메시지 수, 그룹은 채팅 수로
        const BATCH_SIZE = 5;
        const results = [];
        
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            const batch = items.slice(i, i + BATCH_SIZE);
            const batchSettled = await Promise.allSettled(
                batch.map(async (item) => {
                    if (item.type === 'group') {
                        // 그룹은 채팅 수 사용 + 즐겨찾기 지원
                        const chatCount = Array.isArray(item.data.chats) ? item.data.chats.length : 0;
                        const isFav = storage.isGroupFavorite(item.data.id);
                        return { item, count: chatCount, isFav };
                    }
                    
                    // 캐릭터는 메시지 수 사용
                    const char = item.data;
                    let count = cache.get('messageCounts', char.avatar);
                    
                    if (typeof count !== 'number') {
                        try {
                            await api.fetchChatsForCharacter(char.avatar);
                            count = cache.get('messageCounts', char.avatar) || 0;
                        } catch (e) {
                            count = 0;
                        }
                    }
                    
                    return { item, count, isFav: isFavoriteChar(char) };
                })
            );
            results.push(...batchSettled.filter(r => r.status === 'fulfilled').map(r => r.value));
        }
        
        results.sort((a, b) => {
            // 1. 즐겨찾기 우선 (캐릭터만)
            if (a.isFav !== b.isFav) {
                return a.isFav ? -1 : 1;
            }
            // 2. 메시지/채팅 수 내림차순
            if (b.count !== a.count) {
                return b.count - a.count;
            }
            // 3. 이름순
            const nameA = a.item.data.name || '';
            const nameB = b.item.data.name || '';
            return nameA.localeCompare(nameB, 'ko');
        });
        
        return results.map(r => r.item);
    }
    
    // recent 또는 name 정렬
    const sorted = [...items];
    
    sorted.sort((a, b) => {
        // 즐겨찾기 우선 (캐릭터 + 그룹 모두)
        const aFav = a.type === 'character' ? isFavoriteChar(a.data) : storage.isGroupFavorite(a.data.id);
        const bFav = b.type === 'character' ? isFavoriteChar(b.data) : storage.isGroupFavorite(b.data.id);
        if (aFav !== bFav) {
            return aFav ? -1 : 1;
        }
        
        if (sortOption === 'name') {
            const nameA = a.data.name || '';
            const nameB = b.data.name || '';
            return nameA.localeCompare(nameB, 'ko');
        }
        
        // 기본: 최근 채팅순
        // 캐릭터: lastChatCache 사용
        // 그룹: date_last_chat 필드 사용 (SillyTavern 서버에서 제공)
        let aDate = 0;
        let bDate = 0;
        
        if (a.type === 'character') {
            aDate = lastChatCache.getForSort(a.data);
        } else {
            // date_last_chat은 밀리초 타임스탬프 (숫자)
            aDate = a.data.date_last_chat || 0;
        }
        
        if (b.type === 'character') {
            bDate = lastChatCache.getForSort(b.data);
        } else {
            bDate = b.data.date_last_chat || 0;
        }
        
        return bDate - aDate;
    });
    
    return sorted;
}

/**
 * 캐릭터 정렬
 * @param {Array} characters - 캐릭터 배열
 * @param {string} sortOption - 정렬 옵션
 * @returns {Promise<Array>}
 */
async function sortCharacters(characters, sortOption) {
    
    if (sortOption === 'chats') {
        // 메시지 수 정렬 - 배치로 API 호출 (동시 요청 제한)
        const BATCH_SIZE = 5;
        const results = [];
        
        for (let i = 0; i < characters.length; i += BATCH_SIZE) {
            const batch = characters.slice(i, i + BATCH_SIZE);
            const batchSettled = await Promise.allSettled(
                batch.map(async (char) => {
                    // 캐시 먼저 확인 (메시지 수)
                    let count = cache.get('messageCounts', char.avatar);
                    
                    // 캐시 없으면 API 호출해서 채팅 가져오고 메시지 수 계산
                    if (typeof count !== 'number') {
                        try {
                            const chats = await api.fetchChatsForCharacter(char.avatar);
                            // fetchChatsForCharacter에서 이미 messageCounts를 캐시에 저장함
                            count = cache.get('messageCounts', char.avatar) || 0;
                        } catch (e) {
                            console.error('[CharacterGrid] Failed to get message count for:', char.name, e);
                            count = 0;
                        }
                    }
                    
                    return { char, count };
                })
            );
            results.push(...batchSettled.filter(r => r.status === 'fulfilled').map(r => r.value));
        }
        
        results.sort((a, b) => {
            // 1. 즐겨찾기 우선
            if (isFavoriteChar(a.char) !== isFavoriteChar(b.char)) {
                return isFavoriteChar(a.char) ? -1 : 1;
            }
            
            // 2. 메시지 수 내림차순 (같으면 이름순)
            if (b.count !== a.count) {
                return b.count - a.count;
            }
            
            // 3. 메시지 수 같으면 이름순
            return (a.char.name || '').localeCompare(b.char.name || '', 'ko');
        });
        
        return results.map(item => item.char);
    }
    
    const sorted = [...characters];
    
    sorted.sort((a, b) => {
        // 즐겨찾기 우선
        if (isFavoriteChar(a) !== isFavoriteChar(b)) {
            return isFavoriteChar(a) ? -1 : 1;
        }
        
        if (sortOption === 'name') {
            return (a.name || '').localeCompare(b.name || '', 'ko');
        }
        
        // 기본: 최근 채팅순 (lastChatCache 사용 - localStorage에 영구 저장됨)
        // 재접속 시에도 정확한 정렬 유지
        const aDate = lastChatCache.getForSort(a);
        const bDate = lastChatCache.getForSort(b);
        return bDate - aDate;
    });
    
    return sorted;
}

// ============================================
// 이벤트 위임 설정
// ============================================

/**
 * 캐릭터/그룹 그리드 컨테이너에 이벤트 위임 설정
 * N개 카드 × 4개 리스너 → 컨테이너 1개 × 4개 리스너
 * innerHTML 교체 후에도 자동으로 동작
 * @param {HTMLElement} container
 */
function setupGridDelegation(container) {
    if (delegatedGridContainer === container) return;
    delegatedGridContainer = container;
    
    container.addEventListener('touchstart', (e) => {
        gridTouch.handled = false;
        gridTouch.isScrolling = false;
        gridTouch.startX = e.touches[0].clientX;
        gridTouch.startY = e.touches[0].clientY;
    }, { passive: true });
    
    container.addEventListener('touchmove', (e) => {
        const dx = Math.abs(e.touches[0].clientX - gridTouch.startX);
        const dy = Math.abs(e.touches[0].clientY - gridTouch.startY);
        if (dx > SCROLL_THRESHOLD || dy > SCROLL_THRESHOLD) {
            gridTouch.isScrolling = true;
        }
    }, { passive: true });
    
    container.addEventListener('touchend', (e) => {
        if (!gridTouch.isScrolling) {
            gridTouch.handled = true;
            dispatchGridAction(e, container);
        }
        gridTouch.isScrolling = false;
    });
    
    container.addEventListener('click', (e) => {
        if (!gridTouch.handled) {
            dispatchGridAction(e, container);
        }
        gridTouch.handled = false;
    });
}

/**
 * 태그 컨테이너에 이벤트 위임 설정
 * @param {HTMLElement} container
 */
function setupTagDelegation(container) {
    if (delegatedTagContainer === container) return;
    delegatedTagContainer = container;
    
    container.addEventListener('touchstart', (e) => {
        tagTouch.handled = false;
        tagTouch.isScrolling = false;
        tagTouch.startX = e.touches[0].clientX;
        tagTouch.startY = e.touches[0].clientY;
    }, { passive: true });
    
    container.addEventListener('touchmove', (e) => {
        const dx = Math.abs(e.touches[0].clientX - tagTouch.startX);
        const dy = Math.abs(e.touches[0].clientY - tagTouch.startY);
        if (dx > SCROLL_THRESHOLD || dy > SCROLL_THRESHOLD) {
            tagTouch.isScrolling = true;
        }
    }, { passive: true });
    
    container.addEventListener('touchend', (e) => {
        if (!tagTouch.isScrolling) {
            tagTouch.handled = true;
            handleTagClick(e);
        }
        tagTouch.isScrolling = false;
    });
    
    container.addEventListener('click', (e) => {
        if (!tagTouch.handled) {
            handleTagClick(e);
        }
        tagTouch.handled = false;
    });
}

// ============================================
// 위임 이벤트 핸들러
// ============================================

/**
 * 그리드 클릭/터치 이벤트 분기
 * closest()로 클릭 대상을 판별하여 적절한 핸들러 호출
 */
function dispatchGridAction(e, container) {
    const now = Date.now();
    if (now - lastDelegatedClickTime < DELEGATION_COOLDOWN) return;
    lastDelegatedClickTime = now;
    
    const target = e.target;
    
    // 1) 캐릭터 즐겨찾기 버튼 (그룹 제외)
    const charFavBtn = target.closest('.char-fav-btn:not(.group-fav-btn)');
    if (charFavBtn) {
        e.preventDefault();
        e.stopPropagation();
        handleCharFavToggle(charFavBtn);
        return;
    }
    
    // 2) 그룹 즐겨찾기 버튼
    const groupFavBtn = target.closest('.group-fav-btn');
    if (groupFavBtn) {
        e.preventDefault();
        e.stopPropagation();
        handleGroupFavToggle(groupFavBtn);
        return;
    }
    
    // 3) 그룹 카드 (lobby-group-card는 lobby-char-card의 서브클래스이므로 먼저 체크)
    const groupCard = target.closest('.lobby-group-card');
    if (groupCard) {
        e.preventDefault();
        e.stopPropagation();
        handleGroupCardClick(groupCard, container);
        return;
    }
    
    // 4) 캐릭터 카드
    const charCard = target.closest('.lobby-char-card');
    if (charCard) {
        e.preventDefault();
        e.stopPropagation();
        handleCharCardClick(charCard, container);
        return;
    }
}

/** 캐릭터 즐겨찾기 토글 */
function handleCharFavToggle(favBtn) {
    const charAvatar = favBtn.dataset.charAvatar;
    if (!charAvatar) return;
    
    const card = favBtn.closest('.lobby-char-card');
    const newFavState = storage.toggleCharacterFavorite(charAvatar);
    favBtn.textContent = newFavState ? '★' : '☆';
    if (card) {
        card.dataset.isFav = newFavState.toString();
        card.classList.toggle('is-char-fav', newFavState);
    }
    showToast(newFavState ? '즐겨찾기에 추가됨' : '즐겨찾기에서 제거됨', 'success');
}

/** 그룹 즐겨찾기 토글 */
function handleGroupFavToggle(favBtn) {
    const groupId = favBtn.dataset.groupId;
    if (!groupId) return;
    
    const card = favBtn.closest('.lobby-group-card');
    const newFavState = storage.toggleGroupFavorite(groupId);
    favBtn.textContent = newFavState ? '★' : '☆';
    if (card) {
        card.dataset.isFav = newFavState.toString();
        card.classList.toggle('is-char-fav', newFavState);
    }
    showToast(newFavState ? '즐겨찾기에 추가됨' : '즐겨찾기에서 제거됨', 'success');
}

/** 캐릭터 카드 클릭 — 채팅 패널 열기/닫기 */
async function handleCharCardClick(card, container) {
    if (store.isLobbyLocked) return;
    if (isSelectingCharacter || isRendering) return;
    
    isSelectingCharacter = true;
    
    // safety timeout — 어떤 이유로든 플래그가 해제되지 않을 때 복구
    const selectSafetyTimer = setTimeout(() => {
        if (isSelectingCharacter) {
            console.warn('[CharacterGrid] isSelectingCharacter safety reset');
            isSelectingCharacter = false;
            store.setLobbyLocked(false);
        }
    }, 10000);
    
    store.setLobbyLocked(true);
    
    const charAvatar = card.dataset.charAvatar;
    const charName = card.dataset.charName || 'Unknown';
    
    try {
        // 채팅 패널이 열려있고 같은 캐릭터면 닫기
        const chatsPanel = document.getElementById('chat-lobby-chats');
        const isPanelVisible = chatsPanel?.classList.contains('visible');
        const isSameCharacter = store.currentCharacter?.avatar === charAvatar;
        
        if (isPanelVisible && isSameCharacter) {
            card.classList.remove('selected');
            closeChatPanel();
            return;
        }
        
        // 기존 선택 해제
        container.querySelectorAll('.lobby-char-card.selected').forEach(el => {
            el.classList.remove('selected');
        });
        
        // 새로 선택
        card.classList.add('selected');
        
        // 캐릭터 정보 구성
        const characterData = {
            index: card.dataset.charIndex,
            avatar: charAvatar,
            name: charName,
            avatarSrc: card.querySelector('.lobby-char-avatar')?.src || ''
        };
        
        // 콜백 호출
        const handler = store.onCharacterSelect;
        if (handler && typeof handler === 'function') {
            await handler(characterData);
        } else {
            console.error('[CharacterGrid] onCharacterSelect handler not available!');
        }
    } catch (error) {
        console.error('[CharacterGrid] Handler error:', error);
    } finally {
        clearTimeout(selectSafetyTimer);
        store.setLobbyLocked(false);
        setTimeout(() => { isSelectingCharacter = false; }, 300);
    }
}

/** 그룹 카드 클릭 — 그룹 채팅 패널 열기/닫기 */
async function handleGroupCardClick(card, container) {
    const groupId = card.dataset.groupId;
    if (!groupId) return;
    
    store.setLobbyLocked(true);
    
    try {
        const chatsPanel = document.getElementById('chat-lobby-chats');
        const isPanelVisible = chatsPanel?.classList.contains('visible');
        const isSameGroup = store.currentGroup?.id === groupId;
        
        if (isPanelVisible && isSameGroup) {
            card.classList.remove('selected');
            closeChatPanel();
            return;
        }
        
        if (!isSameGroup) {
            store.setCurrentGroup(null);
            store.setCurrentCharacter(null);
        }
        
        // 기존 선택 해제 (캐릭터 + 그룹 모두)
        container.querySelectorAll('.lobby-char-card.selected, .lobby-group-card.selected').forEach(el => {
            el.classList.remove('selected');
        });
        
        card.classList.add('selected');
        
        const groups = await api.getGroups();
        const group = groups.find(g => g.id === groupId);
        
        if (group) {
            const handler = store.onGroupSelect;
            if (handler && typeof handler === 'function') {
                await handler(group);
            }
        }
    } catch (error) {
        console.error('[CharacterGrid] Group handler error:', error);
    } finally {
        store.setLobbyLocked(false);
    }
}

/** 태그 클릭 — 필터 토글 */
function handleTagClick(e) {
    const tagItem = e.target.closest('.lobby-tag-item');
    if (!tagItem) return;
    
    e.preventDefault();
    
    const tag = tagItem.dataset.tag;
    if (store.selectedTag === tag) {
        store.setSelectedTag(null);
    } else {
        store.setSelectedTag(tag);
    }
    
    renderCharacterGrid(store.searchTerm);
}

// ============================================
// 검색/정렬 핸들러
// ============================================

/**
 * 검색 핸들러 (디바운스 적용)
 * @type {Function}
 */
export const handleSearch = debounce((searchTerm) => {
    renderCharacterGrid(searchTerm);
}, CONFIG.ui.debounceWait);

/**
 * 정렬 변경 핸들러
 * @param {string} sortOption - 정렬 옵션
 */
export function handleSortChange(sortOption) {
    storage.setCharSortOption(sortOption);
    const searchTerm = store.searchTerm;
    renderCharacterGrid(searchTerm, sortOption);
}

// ============================================
// 태그 관련 함수
// ============================================

/**
 * 캐릭터의 태그 가져오기 (SillyTavern 원본에서)
 * @param {Object} char - 캐릭터 객체
 * @returns {string[]}
 */
function getCharacterTags(char) {
    // SillyTavern 태그 구조: char.tags 또는 context.tagMap 사용
    const context = api.getContext();
    
    // 1. context.tagMap에서 태그 가져오기 (SillyTavern 표준)
    if (context?.tagMap && context?.tags && char.avatar) {
        const charTags = context.tagMap[char.avatar] || [];
        return charTags.map(tagId => {
            const tag = context.tags.find(t => t.id === tagId);
            return tag?.name || '';
        }).filter(Boolean);
    }
    
    // 2. Fallback: char.tags 직접 사용
    if (Array.isArray(char.tags)) {
        return char.tags;
    }
    
    return [];
}

/**
 * 전체 캐릭터의 태그 집계
 * @param {Array} characters - 캐릭터 배열
 * @returns {Array<{tag: string, count: number}>}
 */
function aggregateTags(characters) {
    const tagCounts = {};
    
    characters.forEach(char => {
        const tags = getCharacterTags(char);
        tags.forEach(tag => {
            if (tag) {
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            }
        });
    });
    
    // 개수순 정렬
    return Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([tag, count]) => ({ tag, count }));
}

/**
 * 태그바 렌더링
 * @param {Array} characters - 전체 캐릭터 배열
 */
function renderTagBar(characters) {
    const container = document.getElementById('chat-lobby-tag-list');
    if (!container) return;
    
    const tags = aggregateTags(characters);
    
    if (tags.length === 0) {
        container.innerHTML = '';
        return;
    }
    
    const selectedTag = store.selectedTag;
    
    // 횡스크롤이니까 제한 없이 다 보여주기
    container.innerHTML = tags.map(({ tag, count }) => {
        const isActive = selectedTag === tag;
        return `<span class="lobby-tag-item ${isActive ? 'active' : ''}" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}<span class="lobby-tag-count">(${count})</span></span>`;
    }).join('');
    
    // 이벤트 위임 설정 (최초 1회만 리스너 등록)
    setupTagDelegation(container);
}

// bindTagEvents 제거됨 — setupTagDelegation()으로 대체

// ============================================
// 그룹 카드 렌더링
// ============================================

/**
 * 그룹 카드 HTML 생성
 * @param {Object} group - 그룹 객체
 * @param {string} sortOption - 정렬 옵션
 * @returns {string}
 */
function renderGroupCard(group, sortOption = 'recent') {
    const name = group.name || 'Unknown Group';
    const memberCount = Array.isArray(group.members) ? group.members.length : 0;
    const chatCount = Array.isArray(group.chats) ? group.chats.length : 0;
    
    // 즐겨찾기 상태
    const isFav = storage.isGroupFavorite(group.id);
    
    // 마지막 채팅 시간 (최근순 정렬 + 오늘인 경우에만 표시)
    let lastChatTimeStr = '';
    if (sortOption === 'recent' && group.date_last_chat) {
        const lastTime = new Date(group.date_last_chat);
        const now = new Date();
        const isToday = now.toDateString() === lastTime.toDateString();
        
        // 오늘 채팅한 경우에만 시간 표시
        if (isToday) {
            const hours = lastTime.getHours();
            const minutes = String(lastTime.getMinutes()).padStart(2, '0');
            lastChatTimeStr = `${hours}:${minutes}`;
        }
    }
    
    // 멤버 아바타 그리드 생성 (최대 4명)
    const members = group.members || [];
    const avatarGridHtml = renderMemberAvatarGrid(members.slice(0, 4), memberCount);
    
    // 즐겨찾기 버튼
    const favBtn = `<button class="char-fav-btn group-fav-btn" data-group-id="${escapeHtml(group.id)}" title="즐겨찾기 토글">${isFav ? '★' : '☆'}</button>`;
    
    return `
    <div class="lobby-char-card lobby-group-card ${isFav ? 'is-char-fav' : ''}" data-group-id="${escapeHtml(group.id)}" data-is-fav="${isFav}">
        ${favBtn}
        <div class="group-avatar-grid">
            ${avatarGridHtml}
        </div>
        <div class="lobby-char-name">
            <span class="char-name-text">${escapeHtml(name)}${lastChatTimeStr ? ` <span class="char-last-time">${lastChatTimeStr}</span>` : ''}</span>
            <div class="char-hover-info">
                <div class="info-row">
                    <span class="info-icon">👥</span>
                    <span class="info-value">${memberCount}명</span>
                </div>
                <div class="info-row">
                    <span class="info-icon">💬</span>
                    <span class="info-value">${chatCount}개 채팅</span>
                </div>
            </div>
        </div>
        <div class="group-member-badge">👥 ${memberCount}</div>
    </div>
    `;
}

/**
 * 멤버 아바타 그리드 HTML 생성 (카카오톡 스타일)
 * @param {Array} members - 멤버 아바타 배열 (최대 4개)
 * @param {number} totalCount - 전체 멤버 수
 * @returns {string}
 */
function renderMemberAvatarGrid(members, totalCount) {
    const count = members.length;
    
    if (count === 0) {
        // 멤버 없으면 기본 아이콘
        return `<div class="grid-single"><img src="/img/ai4.png" alt="그룹" draggable="false"></div>`;
    }
    
    if (count === 1) {
        // 1명이면 단독 표시
        const avatar = members[0];
        const avatarUrl = `/characters/${encodeURIComponent(avatar)}`;
        return `<div class="grid-single"><img src="${avatarUrl}" alt="member" draggable="false" data-fallback="avatar"></div>`;
    }
    
    if (count === 2) {
        // 2명이면 가로 2분할
        return `<div class="grid-two">${members.map(avatar => {
            const avatarUrl = `/characters/${encodeURIComponent(avatar)}`;
            return `<img src="${avatarUrl}" alt="member" draggable="false" data-fallback="avatar">`;
        }).join('')}</div>`;
    }
    
    if (count === 3) {
        // 3명이면 위 1 + 아래 2
        const avatarUrl0 = `/characters/${encodeURIComponent(members[0])}`;
        const avatarUrl1 = `/characters/${encodeURIComponent(members[1])}`;
        const avatarUrl2 = `/characters/${encodeURIComponent(members[2])}`;
        return `
            <div class="grid-three">
                <div class="grid-top"><img src="${avatarUrl0}" alt="member" draggable="false" data-fallback="avatar"></div>
                <div class="grid-bottom">
                    <img src="${avatarUrl1}" alt="member" draggable="false" data-fallback="avatar">
                    <img src="${avatarUrl2}" alt="member" draggable="false" data-fallback="avatar">
                </div>
            </div>
        `;
    }
    
    // 4명 이상이면 2x2 그리드
    return `<div class="grid-four">${members.slice(0, 4).map(avatar => {
        const avatarUrl = `/characters/${encodeURIComponent(avatar)}`;
        return `<img src="${avatarUrl}" alt="member" draggable="false" data-fallback="avatar">`;
    }).join('')}</div>`;
}

// bindGroupEvents 제거됨 — setupGridDelegation()의 dispatchGridAction()으로 대체
