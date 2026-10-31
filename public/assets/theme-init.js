(function () {
  var theme = 'dark';
  try {
    var saved = localStorage.getItem('mock-studio-theme');
    theme = saved === 'light' || saved === 'dark' ? saved : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (_) { /* 存储不可用时保留默认深色 */ }
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
}());
