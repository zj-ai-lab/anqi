// 内联 SVG 图标（stroke=currentColor，24 viewBox，Lucide 风格手绘）。
// 家规：UI 不用 emoji 当图标；emoji 只留在纯文本媒介（digest/CLI）。
const P = {
  today: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cases: '<path d="M4 7h16v13H4z"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/><path d="M4 12h16"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
  scale: '<path d="M12 3v18M5 21h14"/><path d="M7 6h10"/><path d="M7 6 4 12a3 3 0 0 0 6 0L7 6zM17 6l-3 6a3 3 0 0 0 6 0l-3-6z"/>',
  alarm: '<circle cx="12" cy="13" r="7"/><path d="M12 10v3l2 2"/><path d="M5 4 3 6M19 4l2 2"/>',
  gavel: '<path d="m9 7 6 6M12 4l6 6M4 21h9"/><path d="m5 12 7-7 3 3-7 7z"/>',
  check: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
  wallet: '<path d="M4 7h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z"/><path d="M4 7a2 2 0 0 1 2-2h10"/><circle cx="16" cy="13" r="1"/>',
  inbox: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M6 5h12l2 8v6H4v-6z"/>',
  pen: '<path d="m14 5 5 5L8 21H3v-5z"/><path d="m12 7 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M9 5H5v14h4"/><path d="M13 8l4 4-4 4M17 12H8"/>',
  warn: '<path d="M12 4 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
  flag: '<path d="M5 21V4"/><path d="M5 5h13l-2.5 4L18 13H5"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
  chevL: '<path d="m14 6-6 6 6 6"/>',
  chevR: '<path d="m10 6 6 6-6 6"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  stats: '<line x1="6" y1="20" x2="6" y2="14"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="18" y1="20" x2="18" y2="10"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
  // ── 案件夹浏览器：文件夹 / 按类型区分的文件（fileIcon() 按扩展名派发） ──
  folder: '<path d="M4 6h5l2 2.5h9a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"/>',
  filePdf: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 17v-4h1.2a1.3 1.3 0 0 1 0 2.6H10"/><path d="M14.4 17v-4h1.6"/><path d="M14.4 15.2h1.3"/>',
  fileDoc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 12h5M10 15h5M10 18h3"/>',
  fileImg: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><circle cx="11" cy="13" r="1.2"/><path d="m9 19 3-3 2 2 1.5-1.5L18 18"/>',
  fileSheet: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M9.5 12.5h8M9.5 16h8M13.5 12.5V19"/>',
  fileZip: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M11 3v2M12 5v2M11 7v2M12 9v2M11 11v2"/><rect x="10" y="14" width="3" height="4" rx=".8"/>',
  file: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
};

// 扩展名 → 图标。归类只按「看一眼就知道是什么」的粒度，不做 mime 大全。
const EXT = {
  pdf: 'filePdf',
  doc: 'fileDoc', docx: 'fileDoc', rtf: 'fileDoc', txt: 'fileDoc', md: 'fileDoc', wps: 'fileDoc',
  jpg: 'fileImg', jpeg: 'fileImg', png: 'fileImg', gif: 'fileImg', webp: 'fileImg', heic: 'fileImg', bmp: 'fileImg', svg: 'fileImg',
  xls: 'fileSheet', xlsx: 'fileSheet', csv: 'fileSheet', et: 'fileSheet',
  zip: 'fileZip', rar: 'fileZip', '7z': 'fileZip', gz: 'fileZip',
};

/** 文件名 → 图标名。目录传 isDir=true。 */
export function fileIconName(name, isDir = false) {
  if (isDir) return 'folder';
  const ext = String(name).toLowerCase().split('.').pop();
  return EXT[ext] || 'file';
}

/** 文件名 → <svg>。色相靠 class（.fi-pdf 等）在 CSS 里给，图标本身只画形状。 */
export function fileIconEl(name, isDir = false) {
  const n = fileIconName(name, isDir);
  const tone = { folder: 'fi-folder', filePdf: 'fi-pdf', fileImg: 'fi-img', fileSheet: 'fi-sheet', fileZip: 'fi-zip' }[n] || 'fi-doc';
  return iconEl(n, 'fi ' + tone);
}

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.doc}</svg>`;
}

export function iconEl(name, cls = '') {
  const span = document.createElement('span');
  span.innerHTML = icon(name, cls);
  return span.firstChild;
}
