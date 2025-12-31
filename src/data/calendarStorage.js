// ============================================
// 캘린더 스냅샷 저장소
// ============================================

const STORAGE_KEY = 'chatLobby_calendar';

/**
 * 전체 스냅샷 객체 로드
 * @returns {Object} - { 'YYYY-MM-DD': { total, topChar } }
 */
export function loadSnapshots() {
    try {
        const data = localStorage.getItem(STORAGE_KEY);
        if (data) {
            const parsed = JSON.parse(data);
            return parsed.snapshots || {};
        }
    } catch (e) {
        console.error('[Calendar] Failed to load snapshots:', e);
    }
    return {};
}

/**
 * 특정 날짜 스냅샷 반환
 * @param {string} date - YYYY-MM-DD 형식
 * @returns {{ total: number, topChar: string }|null}
 */
export function getSnapshot(date) {
    const snapshots = loadSnapshots();
    return snapshots[date] || null;
}

/**
 * 해당 날짜 스냅샷 저장 (덮어쓰기)
 * @param {string} date - YYYY-MM-DD 형식
 * @param {number} total - 전체 채팅 수
 * @param {string} topChar - 1위 캐릭터 아바타
 */
export function saveSnapshot(date, total, topChar) {
    try {
        const snapshots = loadSnapshots();
        snapshots[date] = { total, topChar };
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ snapshots }));
    } catch (e) {
        console.error('[Calendar] Failed to save snapshot:', e);
    }
}

/**
 * 해당 날짜 데이터 있는지 확인
 * @param {string} date - YYYY-MM-DD 형식
 * @returns {boolean}
 */
export function hasSnapshot(date) {
    const snapshots = loadSnapshots();
    return !!snapshots[date];
}

/**
 * 전날 대비 증가량 계산
 * @param {string} date - YYYY-MM-DD 형식
 * @returns {number|null} - 증가량 (전날 데이터 없으면 null)
 */
export function getIncrease(date) {
    const snapshots = loadSnapshots();
    const today = snapshots[date];
    
    if (!today) return null;
    
    // 전날 날짜 계산
    const dateObj = new Date(date);
    dateObj.setDate(dateObj.getDate() - 1);
    const prevDate = dateObj.toISOString().split('T')[0];
    
    const prev = snapshots[prevDate];
    
    if (!prev) return null;
    
    return today.total - prev.total;
}
