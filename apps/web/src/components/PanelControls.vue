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
    <button type="button" :title="collapsed ? 'Expand panel' : 'Collapse panel'" @click="toggleCollapse">
      <span aria-hidden="true">{{ collapsed ? '+' : '−' }}</span>
    </button>
    <button type="button" title="Fullscreen panel" @click="toggleFullscreen"><span aria-hidden="true">⛶</span></button>
  </div>
</template>

<style scoped>
.panel-controls {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 2px;
  margin-left: auto;
  padding: 3px;
  border: 1px solid #2a3d59;
  border-radius: 9px;
  background: #0c1727;
  box-shadow: inset 0 1px rgb(255 255 255 / 4%);
}
.panel-controls button {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #aebfd5;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition:
    background 150ms ease,
    color 150ms ease;
}
.panel-controls button:hover {
  background: #223957;
  color: #fff;
}
:global(.panel.panel-collapsed > :not(.panel-header)) {
  display: none !important;
}
:global(.panel.panel-collapsed) {
  height: auto !important;
  min-height: 0 !important;
}
:global(.workspace:has(> .panel:first-child.panel-collapsed)) {
  grid-template-columns: 52px minmax(0, 1fr);
}
:global(.workspace:has(> .panel:last-child.panel-collapsed)) {
  grid-template-columns: minmax(0, 1fr) 52px;
}
:global(.workspace > .panel.panel-collapsed .panel-header) {
  justify-content: center;
  min-height: 46px;
  padding: 8px;
}
:global(.workspace > .panel.panel-collapsed .panel-header > :not(.panel-controls):not(:has(.panel-controls))) {
  display: none !important;
}
:global(.workspace > .panel.panel-collapsed .panel-header > :has(.panel-controls)) {
  display: contents;
}
:global(.workspace > .panel.panel-collapsed .panel-header > :has(.panel-controls) > :not(.panel-controls)) {
  display: none !important;
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
