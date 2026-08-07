import { reactive } from 'vue';

type MessageType = 'success' | 'error' | 'warning' | 'info';
type Validator = (value: string) => true | string;

export const messageState = reactive({
  open: false,
  text: '',
  type: 'info' as MessageType,
});

function showMessage(type: MessageType, value: unknown) {
  messageState.open = false;
  messageState.text = String(value ?? '');
  messageState.type = type;
  window.setTimeout(() => {
    messageState.open = true;
  });
}

export const ElMessage = {
  success: (value: unknown) => showMessage('success', value),
  error: (value: unknown) => showMessage('error', value),
  warning: (value: unknown) => showMessage('warning', value),
  info: (value: unknown) => showMessage('info', value),
};

export const dialogState = reactive({
  open: false,
  kind: 'confirm' as 'confirm' | 'prompt',
  title: '',
  message: '',
  value: '',
  placeholder: '',
  error: '',
});

let resolveDialog: ((value: unknown) => void) | undefined;
let rejectDialog: ((reason: string) => void) | undefined;
let validator: Validator | undefined;

function openDialog(kind: 'confirm' | 'prompt', message: string, title: string) {
  dialogState.kind = kind;
  dialogState.title = title;
  dialogState.message = message;
  dialogState.value = '';
  dialogState.placeholder = '';
  dialogState.error = '';
  dialogState.open = true;
  return new Promise<unknown>((resolve, reject) => {
    resolveDialog = resolve;
    rejectDialog = reject;
  });
}

export const ElMessageBox = {
  confirm(message: string, title = 'Confirm', _options: unknown = {}) {
    validator = undefined;
    return openDialog('confirm', message, title) as Promise<void>;
  },
  prompt(message: string, title = 'Input', options: { inputPlaceholder?: string; inputValidator?: Validator } = {}) {
    validator = options.inputValidator;
    const result = openDialog('prompt', message, title) as Promise<{ value: string }>;
    dialogState.placeholder = options.inputPlaceholder ?? '';
    return result;
  },
};

export function acceptDialog() {
  if (dialogState.kind === 'prompt' && validator) {
    const result = validator(dialogState.value);
    if (result !== true) {
      dialogState.error = result;
      return;
    }
  }
  dialogState.open = false;
  resolveDialog?.(dialogState.kind === 'prompt' ? { value: dialogState.value } : undefined);
  resolveDialog = undefined;
  rejectDialog = undefined;
}

export function cancelDialog() {
  dialogState.open = false;
  rejectDialog?.('cancel');
  resolveDialog = undefined;
  rejectDialog = undefined;
}
