// ============================================
// 캘린더 뷰 - Wrapped 스타일 오버레이
// ============================================

import { api } from '../api/sillyTavern.js';
import { cache } from '../data/cache.js';
import { loadSnapshots, getSnapshot, saveSnapshot, getIncrease } from '../data/calendarStorage.js';

let calendarOverlay = null;
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth();
let selectedDateInfo = null;

/**
 * 캘린더 뷰 열기
 */
export async function openCalendarView() {
    // 오버레이 생성
    if (!calendarOverlay) {
        calendarOverlay = document.createElement('div');
        calendarOverlay.id = 'calendar-overlay';
        calendarOverlay.innerHTML = `
            <div class="calendar-container">
                <div class="calendar-header">
                    <button class="calendar-back" id="calendar-close">←</button>
                    <h3>📅 채팅 캘린더</h3>
                </div>
                <div class="calendar-nav-row">
                    <button class="calendar-nav" id="calendar-prev">◀</button>
                    <span id="calendar-title"></span>
                    <button class="calendar-nav" id="calendar-next">▶</button>
                </div>
                <div class="calendar-weekdays">
                    <span class="sunday">일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span class="saturday">토</span>
                </div>
                <div class="calendar-grid" id="calendar-grid"></div>
                <div class="calendar-detail" id="calendar-detail" style="display: none;">
                    <div class="detail-date" id="detail-date"></div>
                    <div class="detail-increase" id="detail-increase"></div>
                    <div class="detail-char" id="detail-char"></div>
                </div>
                <div class="calendar-footer" id="calendar-footer"></div>
            </div>
        `;
        document.body.appendChild(calendarOverlay);
        
        // 이벤트 바인딩
        calendarOverlay.querySelector('#calendar-close').addEventListener('click', closeCalendarView);
        calendarOverlay.querySelector('#calendar-prev').addEventListener('click', () => navigateMonth(-1));
        calendarOverlay.querySelector('#calendar-next').addEventListener('click', () => navigateMonth(1));
        calendarOverlay.addEventListener('click', (e) => {
            if (e.target === calendarOverlay) closeCalendarView();
        });
        
        // 날짜 클릭 이벤트 위임
        calendarOverlay.querySelector('#calendar-grid').addEventListener('click', handleDateClick);
    }
    
    calendarOverlay.style.display = 'flex';
    selectedDateInfo = null;
    
    // 오늘 스냅샷 저장 (매번 연산)
    await saveTodaySnapshot();
    
    // 캘린더 렌더링
    renderCalendar();
}

/**
 * 캘린더 뷰 닫기
 */
export function closeCalendarView() {
    if (calendarOverlay) {
        calendarOverlay.style.display = 'none';
    }
}

/**
 * 월 이동
 */
function navigateMonth(delta) {
    currentMonth += delta;
    if (currentMonth < 0) {
        currentMonth = 11;
        currentYear--;
    } else if (currentMonth > 11) {
        currentMonth = 0;
        currentYear++;
    }
    selectedDateInfo = null;
    renderCalendar();
}

/**
 * 오늘 스냅샷 저장 (매번 연산 실행)
 */
async function saveTodaySnapshot() {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // 캐릭터 목록 가져오기
        let characters = cache.get('characters', 'all');
        if (!characters) {
            characters = await api.fetchCharacters();
        }
        
        // 전체 채팅 수 계산 + 1위 캐릭터 찾기 (statsView.js 로직 재활용)
        const rankings = [];
        
        for (const char of characters) {
            let chats = cache.get('chats', char.avatar);
            if (!chats || !Array.isArray(chats)) {
                try {
                    chats = await api.fetchChatsForCharacter(char.avatar);
                } catch {
                    chats = [];
                }
            }
            const chatCount = Array.isArray(chats) ? chats.length : 0;
            const messageCount = Array.isArray(chats) 
                ? chats.reduce((sum, chat) => sum + (chat.chat_items || 0), 0) 
                : 0;
            rankings.push({ name: char.name, avatar: char.avatar, chatCount, messageCount });
        }
        
        // 메시지 수로 정렬해서 1위 찾기
        rankings.sort((a, b) => b.messageCount - a.messageCount);
        
        const totalChats = rankings.reduce((sum, r) => sum + r.chatCount, 0);
        const topChar = rankings[0]?.avatar || '';
        
        saveSnapshot(today, totalChats, topChar);
        
    } catch (e) {
        console.error('[Calendar] Failed to save today snapshot:', e);
    }
}

/**
 * 캘린더 렌더링
 */
function renderCalendar() {
    const title = calendarOverlay.querySelector('#calendar-title');
    const grid = calendarOverlay.querySelector('#calendar-grid');
    const footer = calendarOverlay.querySelector('#calendar-footer');
    const detail = calendarOverlay.querySelector('#calendar-detail');
    
    title.textContent = `${currentYear}년 ${currentMonth + 1}월`;
    
    // 해당 월 첫째 날 요일과 마지막 날짜
    const firstDay = new Date(currentYear, currentMonth, 1).getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    
    // 스냅샷 데이터 가져오기
    const snapshots = loadSnapshots();
    
    // 그리드 생성
    let html = '';
    
    // 빈 셀 (첫째 주 시작 전)
    for (let i = 0; i < firstDay; i++) {
        html += '<div class="calendar-day empty"></div>';
    }
    
    // 날짜 셀
    const today = new Date().toISOString().split('T')[0];
    
    for (let day = 1; day <= daysInMonth; day++) {
        const date = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const snapshot = snapshots[date];
        const isToday = date === today;
        const hasData = !!snapshot;
        
        let content = '';
        if (hasData && snapshot.topChar) {
            // topChar 아바타 썸네일 표시
            const avatarUrl = `/characters/${encodeURIComponent(snapshot.topChar)}`;
            content = `<img class="day-avatar" src="${avatarUrl}" alt="" onerror="this.style.display='none'">`;
        } else if (!hasData) {
            content = '<span class="day-no-data">-</span>';
        }
        
        html += `
            <div class="calendar-day ${isToday ? 'today' : ''} ${hasData ? 'has-data' : ''}" data-date="${date}">
                <span class="day-number">${day}</span>
                ${content}
            </div>
        `;
    }
    
    grid.innerHTML = html;
    
    // 상세 정보 숨김
    detail.style.display = selectedDateInfo ? 'block' : 'none';
    if (selectedDateInfo) {
        showDateDetail(selectedDateInfo);
    }
    
    // 푸터에 통계 표시
    const totalDays = Object.keys(snapshots).length;
    footer.textContent = `📊 기록된 날: ${totalDays}일`;
}

/**
 * 날짜 클릭 핸들러
 */
function handleDateClick(e) {
    const dayEl = e.target.closest('.calendar-day');
    if (!dayEl || dayEl.classList.contains('empty')) return;
    
    const date = dayEl.dataset.date;
    const snapshot = getSnapshot(date);
    
    if (!snapshot) {
        // 데이터 없는 날짜
        selectedDateInfo = null;
        calendarOverlay.querySelector('#calendar-detail').style.display = 'none';
        return;
    }
    
    selectedDateInfo = date;
    showDateDetail(date);
}

/**
 * 날짜 상세 정보 표시
 */
function showDateDetail(date) {
    const detail = calendarOverlay.querySelector('#calendar-detail');
    const dateEl = calendarOverlay.querySelector('#detail-date');
    const increaseEl = calendarOverlay.querySelector('#detail-increase');
    const charEl = calendarOverlay.querySelector('#detail-char');
    
    const snapshot = getSnapshot(date);
    if (!snapshot) return;
    
    // 날짜 표시
    const dateObj = new Date(date);
    const monthDay = `${dateObj.getMonth() + 1}월 ${dateObj.getDate()}일`;
    dateEl.textContent = monthDay;
    
    // 증감량 계산
    const increase = getIncrease(date);
    if (increase !== null) {
        if (increase > 0) {
            increaseEl.textContent = `+${increase}개 채팅 증가`;
            increaseEl.className = 'detail-increase positive';
        } else if (increase < 0) {
            increaseEl.textContent = `${increase}개 채팅 감소`;
            increaseEl.className = 'detail-increase negative';
        } else {
            increaseEl.textContent = `변화 없음`;
            increaseEl.className = 'detail-increase zero';
        }
    } else {
        increaseEl.textContent = `총 ${snapshot.total}개 채팅`;
        increaseEl.className = 'detail-increase first';
    }
    
    // topChar 표시
    if (snapshot.topChar) {
        const avatarUrl = `/characters/${encodeURIComponent(snapshot.topChar)}`;
        const charName = snapshot.topChar.replace(/\.[^/.]+$/, ''); // 확장자 제거
        charEl.innerHTML = `
            <img class="detail-avatar" src="${avatarUrl}" alt="${charName}" onerror="this.style.display='none'">
            <span class="detail-char-name">${charName}</span>
            <span class="detail-char-label">가장 많이 대화함</span>
        `;
    } else {
        charEl.innerHTML = '';
    }
    
    detail.style.display = 'block';
}
