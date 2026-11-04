export function bindTheme() {
  const root = document.documentElement;
  const button = document.querySelector('#theme-switch');
  const paint = () => {
    const night = root.dataset.theme === 'night';
    document.querySelector('meta[name="theme-color"]').content = night ? '#0a1120' : '#dce9f6';
    button.setAttribute('aria-label', night ? '切换到白天主题' : '切换到夜晚主题');
    button.querySelector('span').textContent = night ? '白天' : '夜晚';
    button.querySelector('use').setAttribute('href', night ? '#i-sun' : '#i-moon');
  };
  button.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'night' ? 'day' : 'night';
    try { localStorage.setItem('avatar-theme', root.dataset.theme); } catch {}
    paint();
  });
  paint();
}
