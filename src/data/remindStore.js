// ============================================
// 리마인드(북마크) 저장소
// "이 채팅의 120~130 구간 서사가 좋았으니 나중에 다시 봐야지"
// 채팅 단위 또는 메시지 범위 단위로 메모와 함께 저장
// ============================================

const STORAGE_KEY = 'chatLobby_reminds';

/**
 * @typedef {Object} Remind
 * @property {string} id - 고유 ID
 * @property {string} avatar - 캐릭터 아바타
 * @property {string} charName - 캐릭터 이름 (표시용)
 * @property {string} fileName - 채팅 파일명 (.jsonl 제거)
 * @property {number|null} start - 시작 메시지 번호 (mesid, 0-based). null = 전체
 * @property {number|null} end - 끝 메시지 번호 (포함). null = 전체/끝까지
 * @property {string} note - 메모
 * @property {number} createdAt - 생성 시각 (ms)
 */

class RemindStore {
    constructor() {
        /** @type {Remind[]|null} */
        this._data = null;
    }

    /** @returns {Remind[]} */
    _load() {
        if (this._data) return this._data;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            this._data = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(this._data)) this._data = [];
        } catch (e) {
            console.warn('[RemindStore] Failed to load:', e);
            this._data = [];
        }
        return this._data;
    }

    _save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
        } catch (e) {
            console.warn('[RemindStore] Failed to save:', e);
        }
    }

    /**
     * 전체 목록 (최신순)
     * @returns {Remind[]}
     */
    getAll() {
        return [...this._load()].sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * 리마인드 추가
     * @param {Omit<Remind, 'id'|'createdAt'>} remind
     * @returns {Remind}
     */
    add(remind) {
        const data = this._load();
        const entry = {
            ...remind,
            id: 'rm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            createdAt: Date.now(),
        };
        data.push(entry);
        this._save();
        return entry;
    }

    /**
     * 리마인드 삭제
     * @param {string} id
     * @returns {boolean}
     */
    remove(id) {
        const data = this._load();
        const idx = data.findIndex(r => r.id === id);
        if (idx === -1) return false;
        data.splice(idx, 1);
        this._save();
        return true;
    }

    /**
     * ID로 조회
     * @param {string} id
     * @returns {Remind|null}
     */
    get(id) {
        return this._load().find(r => r.id === id) || null;
    }

    /**
     * 채팅 이름 변경 시 동기화
     * @param {string} avatar
     * @param {string} oldFileName
     * @param {string} newFileName
     */
    renameChat(avatar, oldFileName, newFileName) {
        const oldName = (oldFileName || '').replace(/\.jsonl$/i, '');
        const newName = (newFileName || '').replace(/\.jsonl$/i, '');
        let changed = false;
        for (const r of this._load()) {
            if (r.avatar === avatar && r.fileName === oldName) {
                r.fileName = newName;
                changed = true;
            }
        }
        if (changed) this._save();
    }

    /**
     * 캐릭터 삭제 시 정리
     * @param {string} avatar
     */
    removeByAvatar(avatar) {
        const data = this._load();
        const before = data.length;
        this._data = data.filter(r => r.avatar !== avatar);
        if (this._data.length !== before) this._save();
    }
}

export const remindStore = new RemindStore();
