// ============================================
// 전역 작업 Lock 싱글톤 (토큰 기반)
// 채팅 열기 등 SillyTavern API를 호출하는 작업이
// 동시에 여러 개 실행되지 않도록 직렬화
//
// ★ 토큰 기반인 이유:
// 안전 타임아웃이 락만 풀고 작업 자체는 취소하지 못하면,
// 느린 기기에서 "이전 작업이 아직 진행 중인데 새 작업이 시작"되어
// 채팅 save/load가 겹치는(덮어쓰기) 사고가 날 수 있다.
// - acquire()가 토큰을 반환하고, release(token)는 토큰이 일치할 때만 해제
// - 안전 타임아웃으로 해제된 뒤의 stale 작업은 isCurrent(token)으로
//   자신이 무효화되었음을 감지하고 이후 단계를 스스로 중단해야 한다
// ============================================

class OperationLock {
    constructor() {
        /** @type {number} 토큰 시퀀스 */
        this._seq = 0;
        /** @type {number|null} 현재 활성 토큰 (null = 해제 상태) */
        this._token = null;
        /** @type {string|null} */
        this._currentOp = null;
        /** @type {ReturnType<setTimeout>|null} */
        this._safetyTimer = null;
    }

    /** 현재 잠금 상태 */
    get isLocked() { return this._token !== null; }

    /** 현재 실행 중인 작업명 */
    get currentOp() { return this._currentOp; }

    /**
     * Lock 획득 시도
     * @param {string} opName - 작업 이름 (디버그용)
     * @param {number} timeout - 안전 해제 타임아웃 (ms)
     *   ⚠️ 작업의 "최악 소요 시간"보다 길게 잡을 것.
     *   (예: openChat은 waitForChatChanged 5초 × 2회 + 마진 → 15000)
     * @returns {number|null} - 성공 시 토큰, 실패 시 null
     */
    acquire(opName, timeout = 8000) {
        if (this._token !== null) {
            console.warn(`[OperationLock] Blocked: "${opName}" (running: "${this._currentOp}")`);
            return null;
        }
        const token = ++this._seq;
        this._token = token;
        this._currentOp = opName;

        // Safety timeout - 작업이 비정상적으로 오래 걸리면 해제
        // (해당 작업은 isCurrent()로 stale 여부를 확인하고 스스로 중단해야 함)
        this._safetyTimer = setTimeout(() => {
            if (this._token === token) {
                console.warn(`[OperationLock] Safety release: "${opName}" timed out (${timeout}ms)`);
                this._clear();
            }
        }, timeout);

        return token;
    }

    /**
     * 해당 토큰이 아직 유효한(현재 활성) 작업인지 확인
     * 안전 타임아웃으로 해제됐거나 다른 작업이 시작됐으면 false
     * @param {number|null} token
     * @returns {boolean}
     */
    isCurrent(token) {
        return token !== null && token !== undefined && token === this._token;
    }

    /**
     * Lock 해제 (토큰 일치 시에만)
     * @param {number|null} token - acquire()가 반환한 토큰
     * @returns {boolean} - 실제로 해제됐는지
     */
    release(token) {
        if (!this.isCurrent(token)) {
            // stale 작업의 늦은 release → 무시 (새 작업의 락을 풀어버리면 안 됨)
            return false;
        }
        this._clear();
        return true;
    }

    /** 내부 상태 초기화 */
    _clear() {
        this._token = null;
        this._currentOp = null;
        if (this._safetyTimer) {
            clearTimeout(this._safetyTimer);
            this._safetyTimer = null;
        }
    }
}

export const operationLock = new OperationLock();
