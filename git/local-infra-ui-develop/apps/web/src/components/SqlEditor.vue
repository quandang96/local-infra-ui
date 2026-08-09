<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as monaco from 'monaco-editor';

const model = defineModel<string>({ required: true });
const props = withDefaults(defineProps<{ language?: string }>(), { language: 'sql' });
const host = ref<HTMLElement>();
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let themeObserver: MutationObserver | undefined;

function monacoTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark';
}

onMounted(() => {
  editor = monaco.editor.create(host.value!, {
    value: model.value,
    language: props.language,
    theme: monacoTheme(),
    minimap: { enabled: false },
    automaticLayout: true,
    fontSize: 13,
    scrollBeyondLastLine: false,
  });
  editor.onDidChangeModelContent(() => {
    model.value = editor?.getValue() ?? '';
  });
  themeObserver = new MutationObserver(() => monaco.editor.setTheme(monacoTheme()));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
});
watch(model, (value) => {
  if (editor && value !== editor.getValue()) editor.setValue(value);
});
function selectedText() {
  const selection = editor?.getSelection();
  const value = selection ? editor?.getModel()?.getValueInRange(selection) : '';
  return value?.trim() ?? '';
}
defineExpose({ selectedText });
onBeforeUnmount(() => {
  themeObserver?.disconnect();
  editor?.dispose();
});
</script>
<template><div ref="host" class="sql-editor" /></template>
