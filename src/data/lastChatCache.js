// ============================================
// 마지막 채팅 시간 캐시 관리
// SillyTavern의 date_last_chat이 실시간 갱신 안 되는 문제 해결
// + 재접속 시에도 실제 채팅 기록 기반 정렬 지원
// ============================================

import { api } from '../api/sillyTavern.js';
import { cache } from './cache.js';

// localStorage 키
const STORAGE_KEY = 'chatLobby_lastChatTimes';

/**
 * 캐릭터별 마지막 채팅 시간 캐시
 * - 메모리 캐시 + localStorage 영구 저장
 * - 재접속 시에도 정확한 정렬 유지
 */
class LastChatCache {
    constructor() {
        // 캐릭터 아바타 -> 마지막 채팅 타임스탬프
        this.lastChatTimes = new Map();
        this.initialized = false;
        this.initializing = false;
        this._dirty = false; // 저장 필요 여부
        
        // localStorage에서 복원
        this._loadFromStorage();
    }
    
    /**
     * localStorage에서 캐시 복원
     */
    _loadFromStorage() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored);
                if (data && typeof data === 'object') {
                    Object.entries(data).forEach(([avatar, timestamp]) => {
                        if (typeof timestamp === 'number' && timestamp > 0) {
                            this.lastChatTimes.set(avatar, timestamp);
                        }
                    });
                    console.log('[LastChatCache] Restored', this.lastChatTimes.size, 'entries from storage');
                }
            }
        } catch (e) {
            console.warn('[LastChatCache] Failed to load from storage:', e);
        }
    }
    
    /**
     * localStorage에 캐시 저장 (debounced)
     */
    _saveToStorage() {
        if (!this._dirty) return;
        
        try {
            const data = {};
            this.lastChatTimes.forEach((timestamp, avatar) => {
                data[avatar] = timestamp;
            });
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            this._dirty = false;
        } catch (e) {
            console.warn('[LastChatCache] Failed to save to storage:', e);
        }
    }
    
    /**
     * 저장 예약 (debounce)
     */
    _scheduleSave() {
        this._dirty = true;
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._saveToStorage(), 1000);
    }
    
    /**
     * 특정 캐릭터의 마지막 채팅 시간 가져오기
     */
    get(charAvatar) {
        return this.lastChatTimes.get(charAvatar) || 0;
    }
    
    /**
     * 특정 캐릭터의 마지막 채팅 시간 설정
     */
    set(charAvatar, timestamp) {
        if (timestamp > 0) {
            const current = this.lastChatTimes.get(charAvatar) || 0;
            // 더 최신 값만 저장
            if (timestamp > current) {
                this.lastChatTimes.set(charAvatar, timestamp);
                this._scheduleSave();
            }
        }
    }
    
    /**
     * 현재 시간으로 마지막 채팅 시간 업데이트 (메시지 전송 시)
     */
    updateNow(charAvatar) {
        if (!charAvatar) return;
        this.lastChatTimes.set(charAvatar, Date.now());
        this._scheduleSave();
        console.log('[LastChatCache] Updated to now:', charAvatar);
    }
    
    /**
     * 채팅 목록에서 마지막 채팅 시간 추출
     */
    extractLastTime(chats) {
        if (!Array.isArray(chats) || chats.length === 0) return 0;
        
        let maxTime = 0;
        for (const chat of chats) {
            const chatTime = this.getChatTimestamp(chat);
            if (chatTime > maxTime) {
                maxTime = chatTime;
            }
        }
        return maxTime;
    }
    
    /**
     * 개별 채팅에서 타임스탬프 추출
     */
    getChatTimestamp(chat) {
        // 1. last_mes가 있으면 사용 (가장 정확)
        if (chat.last_mes) {
            return typeof chat.last_mes === 'number' 
                ? chat.last_mes 
                : new Date(chat.last_mes).getTime();
        }
        
        // 2. file_name에서 날짜 추출 시도
        if (chat.file_name) {
            const timestamp = this.parseFileNameDate(chat.file_name);
            if (timestamp) return timestamp;
        }
        
        // 3. 기타 필드 확인
        if (chat.date) {
            return typeof chat.date === 'number'
                ? chat.date
                : new Date(chat.date).getTime();
        }
        
        return 0;
    }
    
    /**
     * 파일명에서 날짜 파싱
     * 형식: "2024-12-30@15h30m45s.jsonl" 또는 "캐릭터명 - 2024-12-30@15h30m45s.jsonl"
     */
    parseFileNameDate(fileName) {
        const match = fileName.match(/(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m(\d{2})s/);
        if (!match) return null;
        
        const [, year, month, day, hour, min, sec] = match;
        return new Date(
            parseInt(year),
            parseInt(month) - 1,
            parseInt(day),
            parseInt(hour),
            parseInt(min),
            parseInt(sec)
        ).getTime();
    }
    
    /**
     * 캐릭터의 채팅 목록을 가져와서 마지막 시간 갱신
     */
    async refreshForCharacter(charAvatar, chats = null) {
        try {
            if (!chats) {
                chats = cache.get('chats', charAvatar);
                if (!chats) {
                    chats = await api.fetchChatsForCharacter(charAvatar);
                }
            }
            
            const lastTime = this.extractLastTime(chats);
            if (lastTime > 0) {
                this.set(charAvatar, lastTime);
            }
            return lastTime;
        } catch (e) {
            console.error('[LastChatCache] Failed to refresh:', charAvatar, e);
            return 0;
        }
    }
    
    /**
     * 모든 캐릭터의 마지막 채팅 시간 초기화 (배치 처리)
     * 재접속 시 정확한 정렬을 위해 실제 채팅 목록에서 last_mes 확인
     * @param {Array} characters - 캐릭터 목록
     * @param {number} batchSize - 배치 크기
     * @returns {Promise<void>}
     */
    async initializeAll(characters, batchSize = 5) {
        if (this.initializing) {
            console.log('[LastChatCache] Already initializing, skip');
            return;
        }
        
        this.initializing = true;
        console.log('[LastChatCache] Initializing for', characters.length, 'characters');
        
        try {
            // 배치 처리로 메모리 부하 감소
            for (let i = 0; i < characters.length; i += batchSize) {
                const batch = characters.slice(i, i + batchSize);
                
                await Promise.all(batch.map(async (char) => {
                    // 이미 캐시에 값이 있으면 스킵 (재접속 시 이미 localStorage에서 복원됨)
                    const cached = this.get(char.avatar);
                    if (cached > 0) return;
                    
                    // date_last_chat이 있으면 우선 사용 (API 호출 최소화)
                    if (char.date_last_chat) {
                        this.set(char.avatar, char.date_last_chat);
                        return;
                    }
                    
                    // 캐시 없고 date_last_chat도 없으면 채팅 목록 확인 필요
                    // 하지만 초기화 시에는 API 호출을 최소화하기 위해 스킵
                    // 캐릭터 클릭 시 refreshForCharacter에서 갱신됨
                }));
                
                // 배치 간 약간의 딜레이로 메인 스레드 블로킹 방지
                if (i + batchSize < characters.length) {
                    await new Promise(r => setTimeout(r, 10));
                }
            }
            
            this.initialized = true;
            this._saveToStorage(); // 초기화 완료 후 저장
            console.log('[LastChatCache] Initialized with', this.lastChatTimes.size, 'entries');
        } finally {
            this.initializing = false;
        }
    }
    
    /**
     * 캐릭터 정렬용 마지막 채팅 시간 가져오기
     * 1. localStorage에서 복원된 캐시값 (재접속 시에도 유지)
     * 2. context의 date_last_chat (SillyTavern이 관리, 파일 mtime 기준)
     * 3. 0 (채팅 없음)
     */
    getForSort(char) {
        // 캐시값 확인 (localStorage에서 복원된 값 포함)
        const cached = this.get(char.avatar);
        if (cached > 0) return cached;
        
        // fallback: SillyTavern의 date_last_chat 사용
        return char.date_last_chat || 0;
    }
    
    /**
     * 채팅 열기 시 마지막 시간 갱신 (새 채팅 또는 이전 채팅 재진입)
     * 메시지를 보내지 않아도 채팅을 열면 해당 시간으로 기록
     */
    markOpened(charAvatar) {
        if (!charAvatar) return;
        // 채팅을 열면 현재 시간으로 갱신 (접속 시간 기록)
        this.updateNow(charAvatar);
    }
    
    /**
     * 채팅 열기만으로는 캐시를 갱신하지 않음 (하위 호환성)
     */
    markViewed(charAvatar) {
        // 보기만 했을 때는 갱신하지 않음 (no-op)
        console.log('[LastChatCache] markViewed (no update):', charAvatar);
    }
    
    /**
     * 캐시 클리어
     */
    clear() {
        this.lastChatTimes.clear();
        this.initialized = false;
        this.initializing = false;
        this._dirty = false;
        if (this._saveTimer) clearTimeout(this._saveTimer);
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) {
            console.warn('[LastChatCache] Failed to clear storage:', e);
        }
    }
    
    /**
     * 특정 캐릭터 삭제
     * @param {string} charAvatar - 삭제할 캐릭터 아바타
     */
    remove(charAvatar) {
        if (!charAvatar) return;
        if (this.lastChatTimes.has(charAvatar)) {
            this.lastChatTimes.delete(charAvatar);
            this._scheduleSave();
            console.log('[LastChatCache] Removed:', charAvatar);
        }
    }
    
    /**
     * 삭제된 캐릭터들 정리
     * 현재 존재하는 캐릭터 목록과 비교하여 없는 캐릭터 제거
     * @param {Array} existingCharacters - 현재 존재하는 캐릭터 목록
     */
    cleanupDeleted(existingCharacters) {
        if (!existingCharacters || !Array.isArray(existingCharacters)) return;
        
        const existingAvatars = new Set(existingCharacters.map(c => c.avatar));
        let cleaned = 0;
        
        for (const avatar of this.lastChatTimes.keys()) {
            if (!existingAvatars.has(avatar)) {
                this.lastChatTimes.delete(avatar);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            console.log('[LastChatCache] Cleaned', cleaned, 'deleted characters');
            this._scheduleSave();
        }
    }
}

// 싱글톤 인스턴스
export const lastChatCache = new LastChatCache();
