// ============================================
// 캘린더 스냅샷 저장소
//
// 저장 위치: SillyTavern 내장 localforage(IndexedDB) → localStorage quota 탈출
// - ST가 public/lib.js에서 window.localforage로 전역 노출함 (직접 번들 불필요)
// - localforage는 객체를 직렬화 없이 저장(structured clone), IndexedDB→WebSQL→
//   localStorage 자동 폴백이라 모바일 WebView 호환 걱정 없음
//
// 동기 호출부 호환:
// - 진실의 원천은 메모리 캐시(_snapshotsCache)
// - init 시 localforage에서 1회 비동기 로드(+localStorage 자동 마이그레이션)
// - 이후 load/get은 메모리에서 동기 반환, save는 메모리 갱신 + 비동기 영속화
// ============================================

const STORAGE_KEY = 'chatLobby_calendar';
const CURRENT_VERSION = 1; // 구조 변경 시 마이그레이션용

// 메모리 캐시 (동기 인터페이스의 원천)
let _snapshotsCache = null;
let _initialized = false;
let _saveTimer = null;

/**
 * localforage 핸들 (ST가 window에 노출). 없으면 null → localStorage 폴백
 */
function lf() {
    return (typeof window !== 'undefined' && window.localforage) || null;
}

/**
 * localStorage의 캘린더 키 안전 제거 (마이그레이션 후 잔존 청소)
 */
function _safeRemoveLegacy() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* ignore */ }
}

/**
 * localStorage에서 동기 로드 (폴백/마이그레이션용)
 */
function _loadFromLocalStorageSync() {
    try {
        const data = localStorage.getItem(STORAGE_KEY);
        if (data) {
            const parsed = JSON.parse(data);
            return parsed.snapshots || {};
        }
    } catch (e) {
        console.error('[Calendar] localStorage load failed:', e);
    }
    return {};
}

/**
 * 로컬 날짜 문자열 반환 (타임존 안전)
 * @param {Date} date
 * @returns {string} YYYY-MM-DD
 */
export function getLocalDateString(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * 캘린더 저장소 초기화 (앱 시작 시 1회 await)
 * - localforage에서 스냅샷을 메모리로 로드
 * - 기존 localStorage 데이터가 있으면 localforage로 이전 후 localStorage 비움
 * @returns {Promise<void>}
 */
export async function initCalendarStorage() {
    if (_initialized) return;

    const store = lf();
    try {
        if (store) {
            // 1. 양쪽(localforage + localStorage) 상태를 모두 확인
            const lfData = await store.getItem(STORAGE_KEY);
            const lfSnaps = (lfData && lfData.snapshots) ? lfData.snapshots : null;

            let lsSnaps = null;
            try {
                const legacy = localStorage.getItem(STORAGE_KEY);
                if (legacy) lsSnaps = JSON.parse(legacy).snapshots || null;
            } catch (e) {
                // 손상된 잔존 데이터는 무시 (아래에서 청소됨)
                console.warn('[Calendar] Corrupt localStorage residue ignored');
            }

            // 2. 케이스별 처리
            //    핵심 원칙: localforage가 항상 우선(진실의 원천), 충돌 날짜는 localforage 값 유지
            if (lfSnaps && lsSnaps) {
                // 양쪽 공존 (다운그레이드 / 중단된 마이그레이션):
                // 병합(lf 우선) 후 localStorage 잔존 청소 → 고아 데이터/quota 누수 방지
                _snapshotsCache = { ...lsSnaps, ...lfSnaps }; // 뒤(lf)가 우선
                await store.setItem(STORAGE_KEY, { version: CURRENT_VERSION, snapshots: _snapshotsCache });
                _safeRemoveLegacy();
                console.info('[Calendar] Merged residual localStorage into localforage (lf priority)');
            } else if (!lfSnaps && lsSnaps) {
                // 최초 마이그레이션: 통째 이전
                _snapshotsCache = lsSnaps;
                await store.setItem(STORAGE_KEY, { version: CURRENT_VERSION, snapshots: lsSnaps });
                _safeRemoveLegacy();
                console.info('[Calendar] Migrated localStorage → localforage(IndexedDB)');
            } else {
                // localforage만 있음(정상) 또는 둘 다 없음(신규)
                _snapshotsCache = lfSnaps || {};
                // 손상돼서 파싱 실패했지만 키 자체는 남은 경우 청소
                if (!lsSnaps && localStorage.getItem(STORAGE_KEY)) _safeRemoveLegacy();
            }
        } else {
            // localforage 미가용 → localStorage 폴백
            console.warn('[Calendar] window.localforage not found, using localStorage');
            _snapshotsCache = _loadFromLocalStorageSync();
        }
    } catch (e) {
        console.warn('[Calendar] init failed, fallback to localStorage:', e);
        _snapshotsCache = _loadFromLocalStorageSync();
    }

    _initialized = true;

    // 2년 이전 데이터 1회 정리 (용량 관리)
    try {
        cleanOldSnapshots();
    } catch (e) { /* ignore */ }
}

/**
 * 메모리 캐시 → 저장소 영속화 (디바운스 fire-and-forget)
 */
function _persist() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        const payload = { version: CURRENT_VERSION, snapshots: _snapshotsCache || {} };
        const store = lf();
        try {
            if (store) {
                store.setItem(STORAGE_KEY, payload).catch(e => {
                    console.error('[Calendar] localforage persist failed:', e);
                });
            } else {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
            }
        } catch (e) {
            console.error('[Calendar] persist failed:', e);
        }
    }, 500);
}

/**
 * 전체 스냅샷 객체 로드 (동기 - 메모리 캐시)
 * @param {boolean} _forceRefresh - 무시됨(메모리가 항상 최신). 기존 시그니처 호환용
 * @returns {Object} - { 'YYYY-MM-DD': { total, topChar, byChar, lastChatTimes } }
 */
export function loadSnapshots(_forceRefresh = false) {
    if (_snapshotsCache !== null) return _snapshotsCache;

    // init 전 호출 방어: localStorage에서 동기 로드 (init이 곧 덮어씀)
    _snapshotsCache = _loadFromLocalStorageSync();
    return _snapshotsCache;
}

/**
 * 특정 날짜 스냅샷 반환
 * @param {string} date - YYYY-MM-DD 형식
 * @returns {{ total: number, topChar: string, byChar?: Object }|null}
 */
export function getSnapshot(date) {
    const snapshots = loadSnapshots();
    return snapshots[date] || null;
}

/**
 * 오래된 스냅샷 정리 (2년 이전 삭제 - 장기 컨텐츠 보관)
 */
function cleanOldSnapshots() {
    const snapshots = loadSnapshots();
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const cutoff = getLocalDateString(twoYearsAgo);

    let deleted = 0;
    for (const date of Object.keys(snapshots)) {
        if (date < cutoff) {
            delete snapshots[date];
            deleted++;
        }
    }

    if (deleted > 0) {
        console.debug('[Calendar] Deleted', deleted, 'old snapshots (2+ years)');
        _persist();
    }
}

/**
 * 해당 날짜 스냅샷 저장 (덮어쓰기 + lastChatTimes 병합)
 * @param {string} date - YYYY-MM-DD 형식
 * @param {number} total - 전체 채팅 수
 * @param {string} topChar - 1위 캐릭터 아바타
 * @param {Object} byChar - 캐릭터별 채팅수 { avatar: count }
 * @param {Object} lastChatTimes - 캐릭터별 마지막 채팅 시간 { avatar: timestamp }
 * @param {boolean} isBaseline - 베이스라인 여부 (작년 날짜 허용)
 */
export function saveSnapshot(date, total, topChar, byChar = {}, lastChatTimes = {}, isBaseline = false) {
    // 올해 1월 1일 이전 데이터는 저장 안 함 (베이스라인 예외)
    const thisYear = new Date().getFullYear();
    const jan1 = `${thisYear}-01-01`;
    if (!isBaseline && date < jan1) return;

    const snapshots = loadSnapshots();

    // 기존 스냅샷의 lastChatTimes와 병합 (새 값이 우선)
    const existingTimes = snapshots[date]?.lastChatTimes || {};
    const mergedLastChatTimes = { ...existingTimes, ...lastChatTimes };

    snapshots[date] = { total, topChar, byChar, lastChatTimes: mergedLastChatTimes };
    _persist();
}

/**
 * 전체 스냅샷 삭제
 */
export function clearAllSnapshots() {
    _snapshotsCache = {};
    if (_saveTimer) {
        clearTimeout(_saveTimer);
        _saveTimer = null;
    }
    const store = lf();
    try {
        if (store) store.removeItem(STORAGE_KEY).catch(() => {});
    } catch (e) { /* ignore */ }
    // localStorage에 잔존 가능성도 제거 (마이그레이션 전 데이터)
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* ignore */ }
}
