// ============================================
// 캘린더 뷰 - 일별 채팅 증감 표시
// ============================================

import { api } from '../api/sillyTavern.js';
import { cache } from '../data/cache.js';
import { saveSnapshot, getMonthIncreases, loadCalendarData } from '../data/calendarStorage.js';

let calendarOverlay = null;
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth();

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
                    <button class="calendar-nav" id="calendar-prev">◀</button>
                    <h3 id="calendar-title"></h3>
                    <button class="calendar-nav" id="calendar-next">▶</button>
                    <button class="calendar-close" id="calendar-close">✕</button>
                </div>
                <div class="calendar-weekdays">
                    <span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span>
                </div>
                <div class="calendar-grid" id="calendar-grid"></div>
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
    }
    
    calendarOverlay.style.display = 'flex';
    
    // 오늘 스냅샷 저장
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
    renderCalendar();
}

/**
 * 오늘 스냅샷 저장
 */
async function saveTodaySnapshot() {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // 캐릭터 목록 가져오기
        let characters = cache.get('characters', 'all');
        if (!characters) {
            characters = await api.fetchCharacters();
        }
        
        // 전체 채팅 수 계산 (statsView.js 로직 재활용)
        let totalChats = 0;
        
        for (const char of characters) {
            let chats = cache.get('chats', char.avatar);
            if (!chats || !Array.isArray(chats)) {
                try {
                    chats = await api.fetchChatsForCharacter(char.avatar);
                } catch {
                    chats = [];
                }
            }
            totalChats += Array.isArray(chats) ? chats.length : 0;
        }
        
        saveSnapshot(today, totalChats);
        
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
    
    title.textContent = `${currentYear}년 ${currentMonth + 1}월`;
    
    // 해당 월 첫째 날 요일과 마지막 날짜
    const firstDay = new Date(currentYear, currentMonth, 1).getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    
    // 증감량 데이터 가져오기
    const increases = getMonthIncreases(currentYear, currentMonth);
    
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
        const increase = increases[date];
        const isToday = date === today;
        
        let increaseText = '';
        let increaseClass = '';
        
        if (increase === null) {
            increaseText = '---';
            increaseClass = 'no-data';
        } else if (typeof increase === 'object' && increase.isFirst) {
            increaseText = `📝${increase.total}`;
            increaseClass = 'first-record';
        } else if (increase > 0) {
            increaseText = `+${increase}`;
            increaseClass = 'positive';
        } else if (increase < 0) {
            increaseText = `${increase}`;
            increaseClass = 'negative';
        } else {
            increaseText = '±0';
            increaseClass = 'zero';
        }
        
        html += `
            <div class="calendar-day ${isToday ? 'today' : ''}" data-date="${date}">
                <span class="day-number">${day}</span>
                <span class="day-increase ${increaseClass}">${increaseText}</span>
            </div>
        `;
    }
    
    grid.innerHTML = html;
    
    // 푸터에 통계 표시
    const data = loadCalendarData();
    const totalDays = Object.keys(data.snapshots).length;
    footer.textContent = `📊 기록된 날: ${totalDays}일`;
}
