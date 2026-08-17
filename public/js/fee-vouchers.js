// 款项凭证共享组件：案件页与费用页共用。
// 原件只写入案件夹「财务凭证/」；解除关联只删指针，不删文件。
import { el, toast } from './api.js';
import { fileIconEl } from './icons.js';

const KIND_LABEL = {
  receipt: '收款凭证',
  invoice: '发票',
  share_sheet: '分成单',
  other: '其他',
};

function inferKind(name) {
  const value = String(name);
  if (/发票|invoice/i.test(value)) return 'invoice';
  if (/分成|结算单|share/i.test(value)) return 'share_sheet';
  if (/收款|付款|到账|回单|凭证|receipt/i.test(value)) return 'receipt';
  return 'other';
}

function displayName(file) {
  return String(file.rel_path || '').split('/').pop() || '未命名文件';
}

async function uploadVoucher(fee, file) {
  const query = new URLSearchParams({
    name: file.name,
    kind: inferKind(file.name),
    version: String(fee.version),
  });
  const response = await fetch(`/api/fees/${fee.id}/files?${query}`, {
    method: 'PUT',
    // 固定 octet-stream，避免全局 JSON 解析器把 .json 凭证先行消费。
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (response.status === 401) {
    location.href = '/login.html';
    throw new Error('登录已失效');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `上传失败（${response.status}）`);
  }
  return response.json();
}

async function unlinkVoucher(fee, file) {
  const response = await fetch(
    `/api/fees/${fee.id}/files/${file.id}?version=${encodeURIComponent(fee.version)}`,
    { method: 'DELETE' }
  );
  if (response.status === 401) {
    location.href = '/login.html';
    throw new Error('登录已失效');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `解除失败（${response.status}）`);
  }
  return response.json();
}

function voucherChip(fee, file, onChanged) {
  const name = displayName(file);
  const label = KIND_LABEL[file.kind] || KIND_LABEL.other;
  const main = file.missing
    ? el('span', {
      class: 'voucher-file-main is-missing',
      title: `${file.rel_path} 已被移走或改名`,
    }, fileIconEl(name), el('span', {}, name), el('small', {}, '文件已移出案件夹'))
    : el('a', {
      class: 'voucher-file-main',
      href: `/api/cases/${fee.case_id}/file?path=${encodeURIComponent(file.rel_path)}`,
      target: '_blank',
      rel: 'noopener',
      title: file.rel_path,
    }, fileIconEl(name), el('span', {}, name));

  return el('span', { class: `voucher-chip${file.kind === 'share_sheet' ? ' is-share' : ''}` },
    main,
    el('span', { class: 'voucher-kind' }, label),
    el('button', {
      class: 'voucher-unlink',
      type: 'button',
      title: '只解除款项关联，不删除案件夹原件',
      'aria-label': `解除凭证关联：${name}`,
      onclick: async () => {
        if (!confirm(`解除「${name}」与这笔款项的关联？\n\n案件夹中的原文件会保留。`)) return;
        try {
          await unlinkVoucher(fee, file);
          toast('已解除关联，案件夹原件仍保留 ✓');
          await onChanged?.();
        } catch (error) {
          toast(`❌ ${error.message}`, 3200);
        }
      },
    }, '×')
  );
}

export function renderFeeVouchers(fee, { enabled = false, onChanged } = {}) {
  if (!enabled) return null;
  const input = el('input', {
    type: 'file',
    multiple: '',
    class: 'voucher-input',
    'aria-label': `给「${fee.label}」选择凭证`,
  });
  const upload = el('button', {
    class: 'voucher-add',
    type: 'button',
    onclick: () => input.click(),
  }, '＋ 添加凭证');
  const files = el('div', { class: 'voucher-files' },
    ...(fee.vouchers || []).map((file) => voucherChip(fee, file, onChanged))
  );
  const box = el('div', {
    class: 'fee-item-vouchers',
    'aria-label': `${fee.label}的款项凭证`,
  },
    el('div', { class: 'voucher-label' }, '凭证'),
    files,
    upload,
    input,
    el('span', { class: 'voucher-tail' },
      `${(fee.vouchers || []).length} 份 · 存入案件夹/财务凭证`
    )
  );

  const send = async (selected) => {
    const list = [...selected];
    if (!list.length) return;
    upload.disabled = true;
    box.classList.add('is-uploading');
    let completed = 0;
    try {
      for (const file of list) {
        await uploadVoucher(fee, file);
        completed += 1;
      }
      toast(`已挂接 ${completed} 份凭证 ✓`);
      await onChanged?.();
    } catch (error) {
      toast(`❌ ${error.message}`, 3600);
      if (completed) await onChanged?.();
    } finally {
      input.value = '';
      upload.disabled = false;
      box.classList.remove('is-uploading');
    }
  };

  input.addEventListener('change', () => send(input.files));
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  let depth = 0;
  box.addEventListener('dragenter', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    stop(event);
    depth += 1;
    box.classList.add('is-dropping');
  });
  box.addEventListener('dragover', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    stop(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  box.addEventListener('dragleave', (event) => {
    stop(event);
    depth = Math.max(0, depth - 1);
    if (!depth) box.classList.remove('is-dropping');
  });
  box.addEventListener('drop', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    stop(event);
    depth = 0;
    box.classList.remove('is-dropping');
    send(event.dataTransfer.files);
  });
  return box;
}
