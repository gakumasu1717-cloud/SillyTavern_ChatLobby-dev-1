// ============================================
// 캘린더 스냅샷 저장소
// ============================================

const STORAGE_KEY = 'chatLobby_calendar';

/**
 * 스냅샷 데이터 로드
 * @returns {{ snapshots: Object, lastSnapshotDate: string|null }}
 */
export function loadCalendarData() {
    try {
        const data = localStorage.getItem(STORAGE_KEY);
        if (data) {
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('[Calendar] Failed to load data:', e);
    }
    return { snapshots: {}, lastSnapshotDate: null };
}

/**
 * 스냅샷 저장
 * @param {string} date - YYYY-MM-DD 형식
 * @param {number} totalChats - 전체 채팅 수
 */
export function saveSnapshot(date, totalChats) {
    try {
        const data = loadCalendarData();
        data.snapshots[date] = totalChats;
        data.lastSnapshotDate = date;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.error('[Calendar] Failed to save snapshot:', e);
    }
}

/**
 * 특정 날짜의 스냅샷 가져오기
 * @param {string} date - YYYY-MM-DD 형식
 * @returns {number|null}
 */
export function getSnapshot(date) {
    const data = loadCalendarData();
    return data.snapshots[date] ?? null;
}

/**
 * 전날 대비 증가량 계산
 * @param {string} date - YYYY-MM-DD 형식
 * @returns {number|null} - 증가량 (데이터 없으면 null)
 */
export function getIncrease(date) {
    const data = loadCalendarData();
    const todayTotal = data.snapshots[date];
    
    if (todayTotal === undefined) return null;
    
    // 전날 날짜 계산
    const dateObj = new Date(date);
    dateObj.setDate(dateObj.getDate() - 1);
    const prevDate = dateObj.toISOString().split('T')[0];
    
    const prevTotal = data.snapshots[prevDate];
    
    if (prevTotal === undefined) return null;
    
    return todayTotal - prevTotal;
}

/**
 * 특정 월의 모든 날짜별 증감량 가져오기
 * @param {number} year
 * @param {number} month - 0-indexed
 * @returns {Object} - { 'YYYY-MM-DD': increase|null }
 */
export function getMonthIncreases(year, month) {
    const data = loadCalendarData();
    const result = {};
    
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    for (let day = 1; day <= daysInMonth; day++) {
        const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const todayTotal = data.snapshots[date];
        
        if (todayTotal === undefined) {
            result[date] = null;
            continue;
        }
        
        // 전날 계산
        const dateObj = new Date(date);
        dateObj.setDate(dateObj.getDate() - 1);
        const prevDate = dateObj.toISOString().split('T')[0];
        const prevTotal = data.snapshots[prevDate];
        
        if (prevTotal === undefined) {
            // 첫 기록일 - 전체 채팅 수 표시
            result[date] = { isFirst: true, total: todayTotal };
        } else {
            result[date] = todayTotal - prevTotal;
        }
    }
    
    return result;
}
