<script setup lang="ts">
import { ref, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const lowlight = createLowlight(common);
const dialogKind = ref<'Link' | 'Image' | 'Code' | null>(null);
const dialogValue = ref('');
const dialogError = ref('');

const editor = useEditor({
  content: props.modelValue,
  extensions: [
    StarterKit.configure({
      codeBlock: false,
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
    }),
    TextStyle,
    Color,
    Image.configure({ allowBase64: false, inline: false }),
    Placeholder.configure({ placeholder: 'Viết ghi chú của bạn...' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true } }),
    CodeBlockLowlight.configure({ lowlight, enableTabIndentation: true, tabSize: 2 }),
  ],
  editorProps: {
    attributes: { class: 'note-prose', spellcheck: 'true' },
  },
  onUpdate: ({ editor: instance }) => emit('update:modelValue', instance.getHTML()),
});

watch(
  () => props.modelValue,
  (content) => {
    if (editor.value && editor.value.getHTML() !== content)
      editor.value.commands.setContent(content, { emitUpdate: false });
  }
);

function openDialog(kind: 'Link' | 'Image' | 'Code') {
  dialogKind.value = kind;
  dialogError.value = '';
  dialogValue.value =
    kind === 'Link'
      ? (editor.value?.getAttributes('link').href as string | undefined) || 'https://'
      : kind === 'Image'
        ? 'https://'
        : 'javascript';
}

function submitDialog() {
  if (!editor.value) return;
  const value = dialogValue.value.trim();
  if (dialogKind.value === 'Link') {
    if (!value) {
      editor.value.chain().focus().unsetLink().run();
      dialogKind.value = null;
      return;
    }
    try {
      const url = new URL(value, window.location.origin);
      if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) throw new Error('invalid protocol');
      editor.value.chain().focus().extendMarkRange('link').setLink({ href: url.href }).run();
      dialogKind.value = null;
    } catch {
      dialogError.value = 'Chỉ chấp nhận http, https, mailto hoặc tel.';
    }
    return;
  }
  if (dialogKind.value === 'Image') {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
      editor.value.chain().focus().setImage({ src: url.href }).run();
      dialogKind.value = null;
    } catch {
      dialogError.value = 'URL ảnh không hợp lệ. Chỉ chấp nhận http/https.';
    }
    return;
  }
  const language = value || 'plaintext';
  editor.value.chain().focus().toggleCodeBlock({ language }).run();
  dialogKind.value = null;
}

function addTable() {
  editor.value?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
}

function removeTable() {
  editor.value?.chain().focus().deleteTable().run();
}
</script>

<template>
  <div class="rich-note-editor">
    <div v-if="editor" class="note-editor-toolbar" role="toolbar" aria-label="Định dạng ghi chú">
      <v-btn
        size="x-small"
        variant="text"
        icon="mdi-format-bold"
        title="Bold"
        :class="{ active: editor.isActive('bold') }"
        @click="editor.chain().focus().toggleBold().run()"
      />
      <v-btn
        size="x-small"
        variant="text"
        icon="mdi-format-italic"
        title="Italic"
        :class="{ active: editor.isActive('italic') }"
        @click="editor.chain().focus().toggleItalic().run()"
      />
      <v-btn
        size="x-small"
        variant="text"
        icon="mdi-format-underline"
        title="Underline"
        :class="{ active: editor.isActive('underline') }"
        @click="editor.chain().focus().toggleUnderline().run()"
      />
      <v-btn
        size="x-small"
        variant="text"
        icon="mdi-format-strikethrough"
        title="Strike"
        :class="{ active: editor.isActive('strike') }"
        @click="editor.chain().focus().toggleStrike().run()"
      />
      <span class="toolbar-separator"></span>
      <v-btn
        size="x-small"
        variant="text"
        title="Heading 1"
        :class="{ active: editor.isActive('heading', { level: 1 }) }"
        @click="editor.chain().focus().toggleHeading({ level: 1 }).run()"
        >H1</v-btn
      >
      <v-btn
        size="x-small"
        variant="text"
        title="Heading 2"
        :class="{ active: editor.isActive('heading', { level: 2 }) }"
        @click="editor.chain().focus().toggleHeading({ level: 2 }).run()"
        >H2</v-btn
      >
      <v-btn
        size="x-small"
        variant="text"
        icon="mdi-format-list-bulleted"
        title="Bullet list"
        :class="{ active: editor.isActive('bulletList') }"
        @click="editor.chain().focus().toggleBulletList().run()"
      />
      <v-btn
        size="x-small"
        variant="text"
        icon="mdi-format-list-numbered"
        title="Ordered list"
        :class="{ active: editor.isActive('orderedList') }"
        @click="editor.chain().focus().toggleOrderedList().run()"
      />
      <v-btn
        size="x-small"
        variant="text"
        icon="mdi-format-list-checks"
        title="Checklist"
        :class="{ active: editor.isActive('taskList') }"
        @click="editor.chain().focus().toggleTaskList().run()"
      />
      <span class="toolbar-separator"></span>
      <v-btn
        size="x-small"
        variant="text"
        icon="mdi-link-variant"
        title="Link"
        :class="{ active: editor.isActive('link') }"
        @click="openDialog('Link')"
      />
      <v-btn size="x-small" variant="text" icon="mdi-image-outline" title="Ảnh từ URL" @click="openDialog('Image')" />
      <v-btn
        size="x-small"
        variant="text"
        icon="mdi-code-tags"
        title="Code block"
        :class="{ active: editor.isActive('codeBlock') }"
        @click="openDialog('Code')"
      />
      <v-btn size="x-small" variant="text" icon="mdi-table" title="Chèn bảng" @click="addTable" />
      <v-btn
        size="x-small"
        variant="text"
        icon="mdi-table-remove"
        title="Xóa bảng đang chọn"
        :disabled="!editor.isActive('table')"
        @click="removeTable"
      />
      <label class="note-color-control" title="Màu chữ">
        <v-icon icon="mdi-format-color-text" size="17" />
        <input
          type="color"
          aria-label="Màu chữ"
          @input="
            editor
              .chain()
              .focus()
              .setColor(($event.target as HTMLInputElement).value)
              .run()
          "
        />
      </label>
      <span class="toolbar-spacer"></span>
      <v-btn
        size="x-small"
        variant="text"
        icon="mdi-undo"
        title="Undo"
        :disabled="!editor.can().chain().focus().undo().run()"
        @click="editor.chain().focus().undo().run()"
      />
      <v-btn
        size="x-small"
        variant="text"
        icon="mdi-redo"
        title="Redo"
        :disabled="!editor.can().chain().focus().redo().run()"
        @click="editor.chain().focus().redo().run()"
      />
    </div>
    <EditorContent :editor="editor" />
    <v-dialog
      :model-value="Boolean(dialogKind)"
      max-width="440"
      @update:model-value="(isOpen) => !isOpen && (dialogKind = null)"
    >
      <v-card class="note-insert-dialog">
        <v-toolbar>
          <v-card-title class="text-h2 font-weight-bold">
            {{ dialogKind }}
          </v-card-title>
        </v-toolbar>
        <v-card-text>
          <v-text-field
            v-model="dialogValue"
            :label="dialogKind === 'Code' ? 'Ngôn ngữ' : 'URL'"
            :placeholder="dialogKind === 'Code' ? 'javascript' : 'https://'"
            :error-messages="dialogError"
            autofocus
            @keyup.enter="submitDialog"
          />
          <p class="note-insert-help">
            {{
              dialogKind === 'Link'
                ? 'Cho phép http, https, mailto hoặc tel.'
                : dialogKind === 'Image'
                  ? 'Ảnh chỉ được tải từ URL http/https.'
                  : 'Ví dụ: javascript, typescript, json, sql hoặc bash.'
            }}
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialogKind = null">Hủy</v-btn>
          <v-btn color="primary" variant="flat" @click="submitDialog">Chèn</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.rich-note-editor {
  display: flex;
  min-height: 0;
  flex-direction: column;
}
.note-insert-dialog {
  border: 1px solid var(--line);
  background: var(--panel) !important;
}
.note-insert-dialog :deep(.v-card-text) {
  color: var(--text);
}
.note-insert-dialog :deep(.v-card-actions) {
  border-top: 1px solid var(--line);
}
.note-insert-help {
  margin: -4px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.note-editor-toolbar {
  display: flex;
  position: sticky;
  top: 0;
  z-index: 2;
  align-self: flex-start;
  align-items: center;
  width: max-content;
  min-width: 100%;
  flex: 0 0 auto;
  flex-wrap: nowrap;
  gap: 2px;
  padding: 8px 14px;
  box-sizing: border-box;
  overflow: visible;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  white-space: nowrap;
}
.note-editor-toolbar :deep(.v-btn) {
  flex: 0 0 30px;
  min-width: 30px;
  color: var(--muted);
}
.note-editor-toolbar :deep(.v-btn.active) {
  background: var(--control-hover);
  color: var(--el-color-primary);
}
.toolbar-separator {
  width: 1px;
  height: 22px;
  flex: 0 0 1px;
  margin: 0 4px;
  background: var(--line);
}
.toolbar-spacer {
  width: 8px;
  flex: 0 0 8px;
}
.note-color-control {
  display: inline-grid;
  position: relative;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  place-items: center;
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
}
.note-color-control:hover {
  background: var(--control-hover);
}
.note-color-control input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
:deep(.tiptap) {
  min-height: 420px;
  padding: 28px 24px 80px;
  outline: none;
  color: var(--text);
  font-size: 15px;
  line-height: 1.75;
}
:deep(.tiptap p.is-editor-empty:first-child::before) {
  height: 0;
  float: left;
  color: var(--muted);
  content: attr(data-placeholder);
  pointer-events: none;
}
:deep(.tiptap h1),
:deep(.tiptap h2),
:deep(.tiptap h3) {
  margin: 1.15em 0 0.45em;
  line-height: 1.25;
}
:deep(.tiptap h1) {
  font-size: 1.75rem;
}
:deep(.tiptap h2) {
  font-size: 1.4rem;
}
:deep(.tiptap ul),
:deep(.tiptap ol) {
  padding-left: 1.5rem;
}
:deep(.tiptap ul[data-type='taskList']) {
  padding: 0;
  list-style: none;
}
:deep(.tiptap ul[data-type='taskList'] li) {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
:deep(.tiptap ul[data-type='taskList'] label) {
  padding-top: 4px;
}
:deep(.tiptap ul[data-type='taskList'] div) {
  flex: 1;
}
:deep(.tiptap blockquote) {
  margin: 1rem 0;
  padding-left: 1rem;
  border-left: 3px solid var(--el-color-primary);
  color: var(--muted);
}
:deep(.tiptap pre) {
  margin: 1rem 0;
  padding: 16px;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #0b1120;
  color: #dbeafe;
  font:
    13px/1.65 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
:deep(.tiptap code:not(pre code)) {
  padding: 2px 5px;
  border-radius: 5px;
  background: var(--soft);
  color: #f472b6;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
:deep(.tiptap .hljs-keyword),
:deep(.tiptap .hljs-selector-tag),
:deep(.tiptap .hljs-literal) {
  color: #c4b5fd;
}
:deep(.tiptap .hljs-string),
:deep(.tiptap .hljs-attr) {
  color: #86efac;
}
:deep(.tiptap .hljs-number),
:deep(.tiptap .hljs-built_in) {
  color: #fbbf24;
}
:deep(.tiptap .hljs-comment) {
  color: #64748b;
  font-style: italic;
}
:deep(.tiptap .hljs-title),
:deep(.tiptap .hljs-function) {
  color: #7dd3fc;
}
:deep(.tiptap table) {
  width: 100%;
  margin: 1rem 0;
  border-collapse: collapse;
  table-layout: fixed;
}
:deep(.tiptap th),
:deep(.tiptap td) {
  min-width: 90px;
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  vertical-align: top;
}
:deep(.tiptap th) {
  background: var(--soft);
  font-weight: 800;
}
:deep(.tiptap .selectedCell) {
  background: rgb(107 91 255 / 16%);
}
:deep(.tiptap img) {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 1rem auto;
  border-radius: 12px;
}
:deep(.tiptap a) {
  color: var(--el-color-primary);
  text-decoration: underline;
}
</style>
