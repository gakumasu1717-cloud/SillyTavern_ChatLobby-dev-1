// ============================================
// 이벤트 리스너 중앙 관리자
//
// 문제: 모듈마다 addEventListener를 제각각 호출하고
// cleanup 함수도 제각각이라 누가 무엇을 어디에 걸었는지 추적 불가.
// (확장 재로드 시 document/window 리스너가 중복 등록되는 사고의 온상)
//
// 해결: 모든 "오래 사는" 리스너(document/window/영속 컨테이너)는
// 반드시 이 매니저를 통해 그룹 이름과 함께 등록한다.
// - listeners.add('그룹명', target, type, handler, options)
// - listeners.clear('그룹명')   ← 모듈별 cleanup에서 호출
// - listeners.clearAll()        ← 확장 전체 cleanup에서 호출
// - listeners.stats()           ← 디버그: 그룹별 등록 현황
//
// ⚠️ innerHTML 교체로 함께 사라지는 일회성 노드의 리스너는
// 등록할 필요 없음 (노드와 함께 GC됨). 대신 그런 리스너는
// 가능하면 위임(delegation)으로 컨테이너에 1회만 걸 것.
// ============================================

class ListenerManager {
    constructor() {
        /** @type {Map<string, Array<{target: EventTarget, type: string, handler: Function, options: any}>>} */
        this._groups = new Map();
    }

    /**
     * 리스너 등록 (그룹 단위 추적)
     * @param {string} group - 그룹 이름 (모듈/기능 단위, 예: 'global', 'radialMenu', 'tooltip')
     * @param {EventTarget|null} target - 대상 (null이면 무시)
     * @param {string} type - 이벤트 타입
     * @param {Function} handler - 핸들러
     * @param {any} [options] - addEventListener 옵션
     * @returns {Function} handler (체이닝용)
     */
    add(group, target, type, handler, options) {
        if (!target || typeof handler !== 'function') return handler;

        target.addEventListener(type, handler, options);

        if (!this._groups.has(group)) {
            this._groups.set(group, []);
        }
        this._groups.get(group).push({ target, type, handler, options });
        return handler;
    }

    /**
     * 그룹의 모든 리스너 해제
     * @param {string} group
     * @returns {number} 해제된 리스너 수
     */
    clear(group) {
        const list = this._groups.get(group);
        if (!list) return 0;

        for (const { target, type, handler, options } of list) {
            try {
                target.removeEventListener(type, handler, options);
            } catch (e) {
                console.warn(`[ListenerManager] Failed to remove ${group}/${type}:`, e);
            }
        }
        this._groups.delete(group);
        return list.length;
    }

    /**
     * 모든 그룹 해제 (확장 전체 cleanup용)
     */
    clearAll() {
        let total = 0;
        for (const group of [...this._groups.keys()]) {
            total += this.clear(group);
        }
        if (total > 0) {
            console.debug(`[ListenerManager] Cleared ${total} listeners`);
        }
    }

    /**
     * 그룹별 등록 현황 (디버그용)
     * @returns {Object<string, number>}
     */
    stats() {
        const result = {};
        this._groups.forEach((list, group) => {
            result[group] = list.length;
        });
        return result;
    }
}

export const listeners = new ListenerManager();
