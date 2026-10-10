// Apply the remembered appearance before the stylesheet paints either page.
try {
  const choice = localStorage.getItem('aithema-theme');
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
} catch { /* System appearance remains available when storage is blocked. */ }
