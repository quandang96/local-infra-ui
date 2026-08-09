<script setup lang="ts">
import { ref } from 'vue';

const collapsed = ref(false);
const panelFor = (target: EventTarget | null) => (target as HTMLElement | null)?.closest<HTMLElement>('.panel');
function toggleCollapse(event: MouseEvent) {
  const panel = panelFor(event.currentTarget);
  if (!panel) return;
  collapsed.value = !collapsed.value;
  panel.classList.toggle('panel-collapsed', collapsed.value);
}
async function toggleFullscreen(event: MouseEvent) {
  const panel = panelFor(event.currentTarget);
  if (!panel) return;
  if (document.fullscreenElement) await document.exitFullscreen();
  else await panel.requestFullscreen();
}
</script>

<template>
  <div class="panel-controls">
    <v-btn
      size="x-small"
      variant="text"
      :icon="collapsed ? 'mdi-chevron-down' : 'mdi-chevron-up'"
      :title="collapsed ? 'Expand panel' : 'Collapse panel'"
      @click="toggleCollapse"
    />
    <v-btn size="x-small" variant="text" icon="mdi-fullscreen" title="Fullscreen panel" @click="toggleFullscreen" />
  </div>
</template>

<style scoped>
.panel-controls {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 1px;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--input-bg);
}
.panel-controls :deep(.v-btn:hover),
.panel-controls :deep(.v-btn:focus-visible) {
  background: var(--control-hover);
  color: var(--el-color-primary);
}
:global(.panel.panel-collapsed > :not(.panel-header)) {
  display: none !important;
}
:global(.panel.panel-collapsed) {
  height: auto !important;
  min-height: 0 !important;
}
:global(.panel.panel-collapsed .panel-header) {
  border-bottom: 0;
}
:global(.panel:fullscreen) {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: auto;
  border-radius: 0;
  background: var(--bg);
}
</style>
