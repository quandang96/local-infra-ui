<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import DOMPurify from 'dompurify';
import { ElMessage, ElMessageBox } from '../ui';
import { api } from '../api';
import RichNoteEditor from '../components/RichNoteEditor.vue';

type Note = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  isFavorite: boolean;
  isShared: boolean;
  shareToken: string | null;
  createdAt: string;
  updatedAt: string;
};

const accessStorageKey = 'local-infra-notes-access-token';
const accessToken = ref('');
const password = ref('');
const unlockError = ref('');
const passwordDialog = ref(false);
const loading = ref(false);
const saving = ref(false);
const search = ref('');
const sortMode = ref<'updated' | 'created'>('updated');
const notes = ref<Note[]>([]);
const selectedId = ref('');
const draft = reactive({ title: '', content: '', tags: [] as string[], isFavorite: false });
const tagInput = ref('');
const dirty = ref(false);
const lastSavedAt = ref('');
let autosaveTimer: number | undefined;
let saveInFlight: Promise<boolean> | null = null;

const selectedNote = computed(() => notes.value.find((note) => note.id === selectedId.value) ?? null);
const canEdit = computed(() => Boolean(accessToken.value));
const safeDraftContent = computed(() => DOMPurify.sanitize(draft.content, { USE_PROFILES: { html: true } }));
const filteredNotes = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  const matches = query
    ? notes.value.filter((note) =>
        `${note.title}\n${plainText(note.content)}\n${note.tags.join(' ')}`.toLocaleLowerCase().includes(query)
      )
    : notes.value;
  return [...matches].sort((first, second) =>
    sortMode.value === 'updated'
      ? second.updatedAt.localeCompare(first.updatedAt)
      : second.createdAt.localeCompare(first.createdAt)
  );
});
const wordCount = computed(() => plainText(draft.content).split(/\s+/).filter(Boolean).length);
const readMinutes = computed(() => Math.max(1, Math.ceil(wordCount.value / 220)));

function headers() {
  return { 'x-notes-access-token': accessToken.value };
}
function plainText(content: string) {
  const container = document.createElement('div');
  container.innerHTML = DOMPurify.sanitize(content, { USE_PROFILES: { html: true } });
  return container.textContent?.replace(/\s+/g, ' ').trim() || '';
}
function preview(content: string) {
  return plainText(content) || 'Chưa có nội dung';
}
function formatUpdated(value: string) {
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}
async function select(note: Note) {
  if (note.id === selectedId.value) return;
  if (dirty.value && !(await saveNote(true))) return;
  window.clearTimeout(autosaveTimer);
  selectedId.value = note.id;
  draft.title = note.title;
  draft.content = DOMPurify.sanitize(note.content, { USE_PROFILES: { html: true } });
  draft.tags = [...note.tags];
  draft.isFavorite = note.isFavorite;
  dirty.value = false;
}
function replaceNote(note: Note, activate = true) {
  const index = notes.value.findIndex((item) => item.id === note.id);
  if (index >= 0) notes.value.splice(index, 1, note);
  else notes.value.unshift(note);
  notes.value.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
  if (activate) void select(note);
}
function clearSelection() {
  selectedId.value = '';
  draft.title = '';
  draft.content = '';
  draft.tags = [];
  draft.isFavorite = false;
  dirty.value = false;
}
function setNotes(rows: Note[]) {
  notes.value = rows;
  const next = notes.value.find((note) => note.id === selectedId.value) ?? notes.value[0];
  if (next) void select(next);
  else clearSelection();
}
async function load() {
  loading.value = true;
  try {
    const response = await api<{ rows: Note[] }>('/notes', { headers: headers() });
    setNotes(response.rows);
  } catch (cause) {
    accessToken.value = '';
    window.localStorage.removeItem(accessStorageKey);
    unlockError.value = cause instanceof Error ? cause.message : 'Không thể mở Notes';
    await loadPublicNotes();
  } finally {
    loading.value = false;
  }
}
async function loadPublicNotes() {
  loading.value = true;
  try {
    const response = await api<{ rows: Note[] }>('/notes/public');
    setNotes(response.rows);
  } catch (cause) {
    notes.value = [];
    clearSelection();
    unlockError.value = cause instanceof Error ? cause.message : 'Không thể tải note công khai';
  } finally {
    loading.value = false;
  }
}
async function unlock() {
  unlockError.value = '';
  loading.value = true;
  try {
    const response = await api<{ token: string }>('/notes/access', {
      method: 'POST',
      body: JSON.stringify({ password: password.value }),
    });
    accessToken.value = response.token;
    window.localStorage.setItem(accessStorageKey, response.token);
    password.value = '';
    passwordDialog.value = false;
    await load();
  } catch (cause) {
    unlockError.value = cause instanceof Error ? cause.message : 'Không thể mở Notes';
  } finally {
    loading.value = false;
  }
}
async function lockNotes() {
  if (dirty.value && !(await saveNote(true))) return;
  window.clearTimeout(autosaveTimer);
  window.localStorage.removeItem(accessStorageKey);
  accessToken.value = '';
  password.value = '';
  await loadPublicNotes();
}
async function createNote() {
  saving.value = true;
  try {
    const note = await api<Note>('/notes', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ title: 'Ghi chú mới', content: '<p></p>', tags: [], isFavorite: false }),
    });
    replaceNote(note);
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không thể tạo note');
  } finally {
    saving.value = false;
  }
}
function queueAutosave() {
  if (!selectedNote.value) return;
  dirty.value = true;
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => void saveNote(true), 900);
}
async function saveNote(silent = false) {
  if (saveInFlight) {
    const saved = await saveInFlight;
    if (!saved || !dirty.value) return saved;
  }
  const task = persistNote(silent);
  saveInFlight = task;
  try {
    return await task;
  } finally {
    if (saveInFlight === task) saveInFlight = null;
  }
}
async function persistNote(silent: boolean) {
  if (!selectedNote.value) return false;
  const noteId = selectedNote.value.id;
  draft.title = draft.title.trim() || 'Ghi chú không tiêu đề';
  const snapshot = JSON.stringify(draft);
  window.clearTimeout(autosaveTimer);
  saving.value = true;
  try {
    const note = await api<Note>(`/notes/${noteId}`, {
      method: 'PATCH',
      headers: headers(),
      body: snapshot,
    });
    replaceNote(note, selectedId.value === noteId);
    if (selectedId.value === noteId && JSON.stringify(draft) === snapshot) dirty.value = false;
    lastSavedAt.value = note.updatedAt;
    if (!silent) ElMessage.success('Đã lưu note');
    return true;
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không thể lưu note');
    return false;
  } finally {
    saving.value = false;
  }
}
function addTag() {
  const tag = tagInput.value.trim();
  if (!tag || draft.tags.includes(tag) || draft.tags.length >= 12) return;
  draft.tags.push(tag);
  tagInput.value = '';
  queueAutosave();
}
function removeTag(tag: string) {
  draft.tags = draft.tags.filter((item) => item !== tag);
  queueAutosave();
}
function toggleFavorite() {
  draft.isFavorite = !draft.isFavorite;
  queueAutosave();
}
async function setShared(shared: boolean) {
  if (!selectedNote.value) return;
  if (dirty.value && !(await saveNote(true))) return;
  try {
    const note = await api<Note>(`/notes/${selectedNote.value.id}/share`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ shared }),
    });
    replaceNote(note);
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không thể cập nhật chia sẻ');
  }
}
async function removeNote() {
  if (!selectedNote.value) return;
  const deletedId = selectedNote.value.id;
  const hadUnsavedChanges = dirty.value;
  try {
    await ElMessageBox.confirm(`Xóa note “${selectedNote.value.title}”?`, 'Xóa note', { type: 'warning' });
    window.clearTimeout(autosaveTimer);
    dirty.value = false;
    await api(`/notes/${deletedId}`, { method: 'DELETE', headers: headers() });
    notes.value = notes.value.filter((note) => note.id !== deletedId);
    selectedId.value = '';
    if (notes.value[0]) await select(notes.value[0]);
    else {
      draft.title = '';
      draft.content = '';
      draft.tags = [];
      draft.isFavorite = false;
    }
    ElMessage.success('Đã xóa note');
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close') {
      dirty.value = hadUnsavedChanges;
      ElMessage.error(cause instanceof Error ? cause.message : 'Không thể xóa note');
    }
  }
}

onMounted(() => {
  accessToken.value = window.localStorage.getItem(accessStorageKey) || '';
  if (accessToken.value) void load();
  else void loadPublicNotes();
});
onBeforeUnmount(() => {
  window.clearTimeout(autosaveTimer);
  if (dirty.value) void saveNote(true);
});
</script>

<template>
  <section v-if="!canEdit && !loading && !notes.length" class="notes-gate">
    <v-card class="notes-gate-card" rounded="xl">
      <v-card-text>
        <div class="notes-gate-icon"><v-icon icon="mdi-notebook-lock-outline" size="30" /></div>
        <h1>Notes được bảo vệ</h1>
        <p>Không có note nào được mở công khai. Nhập mật khẩu để quản lý workspace riêng tư.</p>
        <v-btn block class="mt-5" color="primary" prepend-icon="mdi-lock-open-outline" @click="passwordDialog = true"
          >Mở Notes</v-btn
        >
      </v-card-text>
    </v-card>
  </section>

  <section v-else class="notes-page">
    <header class="notes-toolbar">
      <div>
        <span class="notes-eyebrow"
          ><v-icon :icon="canEdit ? 'mdi-notebook-outline' : 'mdi-eye-outline'" size="16" />
          {{ canEdit ? 'Workspace riêng tư' : 'Các note đang mở xem' }}</span
        >
        <h1>Notes</h1>
      </div>
      <div class="notes-toolbar-actions">
        <v-btn v-if="canEdit" variant="text" prepend-icon="mdi-lock-outline" @click="lockNotes">Khóa</v-btn>
        <v-btn v-if="canEdit" color="primary" prepend-icon="mdi-plus" :loading="saving" @click="createNote"
          >New note</v-btn
        >
        <v-btn v-else color="primary" prepend-icon="mdi-lock-open-outline" @click="passwordDialog = true"
          >Mở khóa</v-btn
        >
      </div>
    </header>

    <div class="notes-layout">
      <aside class="notes-list-panel">
        <v-text-field
          v-model="search"
          density="comfortable"
          hide-details
          prepend-inner-icon="mdi-magnify"
          placeholder="Tìm kiếm note..."
        />
        <div class="notes-list-tabs">
          <button :class="{ active: sortMode === 'updated' }" @click="sortMode = 'updated'">Mới nhất</button>
          <button :class="{ active: sortMode === 'created' }" @click="sortMode = 'created'">Gần đây</button>
        </div>
        <div class="notes-list-heading">
          <span>{{ filteredNotes.length }} notes</span><span v-if="loading">Đang tải...</span>
        </div>
        <button
          v-for="note in filteredNotes"
          :key="note.id"
          class="note-list-item"
          :class="{ active: note.id === selectedId }"
          @click="select(note)"
        >
          <span class="note-list-title">{{ note.title }}</span>
          <span class="note-list-date">{{ formatUpdated(note.updatedAt) }}</span>
          <span class="note-list-preview">{{ preview(note.content) }}</span>
          <span v-if="note.tags.length" class="note-list-tags">
            <i v-for="tag in note.tags.slice(0, 2)" :key="tag">{{ tag }}</i>
          </span>
          <span class="note-list-icons">
            <v-icon v-if="note.isShared" icon="mdi-lock-open-outline" size="14" />
            <v-icon v-if="note.isFavorite" icon="mdi-star" size="15" />
          </span>
        </button>
        <div v-if="!loading && !filteredNotes.length" class="notes-empty">Chưa có note phù hợp.</div>
      </aside>

      <section v-if="selectedNote" class="notes-editor-panel">
        <header class="notes-editor-header">
          <v-text-field
            v-model="draft.title"
            class="notes-title-input"
            hide-details
            variant="plain"
            aria-label="Tiêu đề note"
            :readonly="!canEdit"
            @update:model-value="canEdit && queueAutosave()"
          />
          <div v-if="canEdit" class="notes-editor-actions">
            <v-btn
              :icon="draft.isFavorite ? 'mdi-star' : 'mdi-star-outline'"
              :color="draft.isFavorite ? 'warning' : undefined"
              size="small"
              variant="text"
              title="Yêu thích"
              @click="toggleFavorite"
            />
            <v-btn
              icon="mdi-delete-outline"
              size="small"
              variant="text"
              title="Xóa"
              :disabled="saving"
              @click="removeNote"
            />
            <v-btn color="primary" size="small" :loading="saving" @click="saveNote(false)">Lưu</v-btn>
          </div>
        </header>
        <div class="notes-editor-meta">
          <span>Cập nhật {{ formatUpdated(selectedNote.updatedAt) }}</span>
          <span v-if="canEdit">{{
            dirty ? 'Đang chờ tự động lưu' : lastSavedAt ? `Đã lưu ${formatUpdated(lastSavedAt)}` : 'Đã lưu'
          }}</span>
          <span v-else>Chỉ xem</span>
        </div>
        <div class="notes-tags-row">
          <v-chip v-for="tag in draft.tags" :key="tag" size="small" :closable="canEdit" @click:close="removeTag(tag)">{{
            tag
          }}</v-chip>
          <input
            v-if="canEdit"
            v-model="tagInput"
            type="text"
            maxlength="40"
            placeholder="+ Tag"
            aria-label="Thêm tag"
            @keyup.enter.prevent="addTag"
            @blur="addTag"
          />
        </div>
        <RichNoteEditor v-if="canEdit" v-model="draft.content" @update:model-value="queueAutosave" />
        <article v-else class="note-public-content" v-html="safeDraftContent"></article>
        <footer class="notes-share-bar">
          <div>
            <strong><v-icon icon="mdi-lock-open-outline" size="16" /> Mở xem trong tab Notes</strong>
            <span>{{
              selectedNote.isShared
                ? 'Bất kỳ ai vào tab Notes đều có thể xem note này.'
                : 'Chỉ người đã mở khóa mới xem được.'
            }}</span>
          </div>
          <span class="notes-document-stats">{{ wordCount }} từ&nbsp; | &nbsp;{{ readMinutes }} phút đọc</span>
          <div v-if="canEdit" class="notes-share-actions">
            <v-switch
              :model-value="selectedNote.isShared"
              color="primary"
              hide-details
              inset
              label="Mở công khai"
              @update:model-value="setShared(Boolean($event))"
            />
          </div>
        </footer>
      </section>

      <section v-else class="notes-editor-empty">
        <v-icon icon="mdi-notebook-plus-outline" size="44" />
        <h2>Tạo note đầu tiên</h2>
        <p>
          {{
            canEdit
              ? 'Ghi chú được lưu riêng tư và chỉ mở sau khi nhập mật khẩu từ biến môi trường.'
              : 'Mở khóa để tạo và quản lý note riêng tư.'
          }}
        </p>
        <v-btn v-if="canEdit" color="primary" prepend-icon="mdi-plus" @click="createNote">New note</v-btn>
        <v-btn v-else color="primary" prepend-icon="mdi-lock-open-outline" @click="passwordDialog = true"
          >Mở khóa</v-btn
        >
      </section>
    </div>
  </section>

  <v-dialog v-model="passwordDialog" max-width="440" @after-leave="unlockError = ''">
    <v-card class="notes-password-dialog" rounded="xl">
      <v-card-title class="notes-password-title">
        <span class="notes-password-icon"><v-icon icon="mdi-notebook-lock-outline" size="24" /></span>
        <span>
          Mở khóa Notes
          <small>Workspace riêng tư</small>
        </span>
      </v-card-title>
      <v-card-text>
        <p>Nhập mật khẩu <code>NOTES_PASSWORD</code> để xem và chỉnh sửa toàn bộ workspace.</p>
        <v-text-field
          v-model="password"
          class="mt-5"
          label="Mật khẩu Notes"
          type="password"
          autocomplete="current-password"
          autofocus
          :error-messages="unlockError"
          @keyup.enter="unlock"
        />
      </v-card-text>
      <v-card-actions class="px-6 pb-6">
        <v-spacer />
        <v-btn variant="text" @click="passwordDialog = false">Hủy</v-btn>
        <v-btn color="primary" :loading="loading" @click="unlock">Mở Notes</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.notes-gate {
  display: grid;
  min-height: calc(100vh - 144px);
  place-items: center;
}
.notes-gate-card {
  width: min(100%, 440px);
  border: 1px solid var(--line);
  background: var(--panel) !important;
}
.notes-gate-card :deep(.v-card-text) {
  padding: 34px;
}
.notes-password-dialog {
  border: 1px solid var(--line);
  background: var(--panel) !important;
}
.notes-password-dialog :deep(.v-card-title) {
  padding: 22px 30px 14px;
}
.notes-password-dialog :deep(.v-card-text) {
  padding: 20px 30px 4px;
}
.notes-password-dialog :deep(.v-card-actions) {
  gap: 8px;
  padding: 14px 30px 26px !important;
  border-top: 1px solid var(--line);
}
.notes-password-title {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--text);
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -0.015em;
  line-height: 1.2;
}
.notes-password-title small {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
}
.notes-password-icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  border-radius: 11px;
  background: var(--soft);
  color: var(--el-color-primary);
}
.notes-password-dialog p {
  margin: 0;
  color: var(--muted);
  line-height: 1.6;
}
.notes-gate-icon {
  display: grid;
  width: 58px;
  height: 58px;
  place-items: center;
  border-radius: 18px;
  background: var(--soft);
  color: var(--el-color-primary);
}
.notes-gate h1 {
  margin: 20px 0 8px;
  font-size: 24px;
}
.notes-gate p {
  margin: 0;
  color: var(--muted);
  line-height: 1.6;
}
.notes-gate code {
  color: var(--el-color-primary);
}
.notes-page {
  display: grid;
  gap: 18px;
}
.notes-toolbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
}
.notes-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.notes-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--el-color-primary);
  font-size: 12px;
  font-weight: 800;
}
.notes-toolbar h1 {
  margin: 3px 0 0;
  font-size: 28px;
  letter-spacing: -0.03em;
}
.notes-layout {
  display: grid;
  min-height: calc(100vh - 190px);
  grid-template-columns: minmax(280px, 0.58fr) minmax(0, 1.42fr);
  gap: 14px;
}
.notes-list-panel,
.notes-editor-panel,
.notes-editor-empty {
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--panel);
  box-shadow: 0 8px 24px rgb(15 23 42 / 5%);
}
.notes-list-panel {
  padding: 14px;
  overflow: auto;
}
.notes-list-tabs {
  display: flex;
  gap: 4px;
  margin: 14px 0 0;
  border-bottom: 1px solid var(--line);
}
.notes-list-tabs button {
  padding: 8px 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
}
.notes-list-tabs button.active {
  border-bottom-color: var(--el-color-primary);
  color: var(--text);
}
.notes-list-heading {
  display: flex;
  justify-content: space-between;
  margin: 14px 4px 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
}
.note-list-item {
  display: grid;
  position: relative;
  width: 100%;
  gap: 6px;
  margin: 3px 0;
  padding: 13px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.note-list-item:hover {
  background: var(--control-hover);
}
.note-list-item.active {
  border-color: rgb(124 92 255 / 75%);
  background: rgb(107 91 255 / 12%);
  box-shadow: 0 0 0 1px rgb(124 92 255 / 16%);
}
.note-list-title {
  overflow: hidden;
  padding-right: 78px;
  font-size: 14px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-list-date {
  position: absolute;
  top: 14px;
  right: 12px;
  color: var(--muted);
  font-size: 10px;
}
.note-list-preview {
  overflow: hidden;
  padding-right: 24px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-list-tags {
  display: flex;
  gap: 4px;
  padding-right: 42px;
}
.note-list-tags i {
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--soft);
  color: var(--el-color-primary);
  font-size: 9px;
  font-style: normal;
  font-weight: 800;
}
.note-list-icons {
  display: flex;
  position: absolute;
  right: 12px;
  bottom: 13px;
  align-items: center;
  gap: 5px;
  color: #fbbf24;
}
.note-list-icons :deep(.mdi-link-variant) {
  color: var(--el-color-primary);
}
.notes-empty {
  padding: 28px 12px;
  color: var(--muted);
  text-align: center;
}
.notes-editor-panel {
  display: grid;
  grid-template-rows: auto auto auto minmax(240px, 1fr) auto;
  min-width: 0;
  max-height: calc(100vh - 190px);
  overflow: hidden;
}
.notes-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 18px 24px 8px;
  border-bottom: 1px solid var(--line);
}
.notes-title-input {
  max-width: 720px;
}
.notes-title-input :deep(input) {
  font-size: 25px;
  font-weight: 800;
  letter-spacing: -0.03em;
}
.notes-editor-actions,
.notes-share-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.notes-editor-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 24px;
  color: var(--muted);
  font-size: 11px;
}
.notes-tags-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 38px;
  padding: 4px 24px 9px;
  overflow-x: auto;
  border-bottom: 1px solid var(--line);
}
.notes-tags-row input {
  width: 92px;
  min-width: 80px;
  padding: 5px 6px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 11px;
}
.notes-editor-panel :deep(.rich-note-editor) {
  min-height: 0;
  overflow: auto;
}
.note-public-content {
  min-height: 240px;
  padding: 28px 24px 80px;
  overflow: auto;
  color: var(--text);
  font-size: 15px;
  line-height: 1.75;
}
.note-public-content :deep(pre) {
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
.note-public-content :deep(code:not(pre code)) {
  padding: 2px 5px;
  border-radius: 5px;
  background: var(--soft);
  color: #f472b6;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.note-public-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
}
.note-public-content :deep(th),
.note-public-content :deep(td) {
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
}
.note-public-content :deep(th) {
  background: var(--soft);
}
.note-public-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 12px;
}
.note-public-content :deep(a) {
  color: var(--el-color-primary);
}
.note-public-content :deep(ul[data-type='taskList']) {
  padding: 0;
  list-style: none;
}
.note-public-content :deep(ul[data-type='taskList'] li) {
  display: flex;
  gap: 8px;
}
.notes-share-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 24px;
  border-top: 1px solid var(--line);
  background: var(--soft);
}
.notes-share-bar strong {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.notes-share-bar span {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
}
.notes-document-stats {
  margin-left: auto;
  white-space: nowrap;
}
.notes-editor-empty {
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 12px;
  padding: 40px;
  color: var(--muted);
  text-align: center;
}
.notes-editor-empty h2 {
  margin: 0;
  color: var(--text);
}
.notes-editor-empty p {
  max-width: 360px;
  margin: 0 0 8px;
  line-height: 1.6;
}
@media (max-width: 900px) {
  .notes-layout {
    grid-template-columns: 1fr;
  }
  .notes-list-panel {
    max-height: 300px;
  }
  .notes-editor-panel {
    min-height: 570px;
  }
}
</style>
