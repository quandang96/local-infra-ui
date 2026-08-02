<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as monaco from 'monaco-editor';

const model = defineModel<string>({ required: true });
const props = withDefaults(defineProps<{ language?: string }>(), { language: 'sql' });
const host = ref<HTMLElement>();
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
onMounted(() => {
  editor = monaco.editor.create(host.value!, {
    value: model.value,
    language: props.language,
    theme: 'vs-dark',
    minimap: { enabled: false },
    automaticLayout: true,
    fontSize: 13,
    scrollBeyondLastLine: false,
  });
  editor.onDidChangeModelContent(() => {
    model.value = editor?.getValue() ?? '';
  });
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
onBeforeUnmount(() => editor?.dispose());
</script>
<template><div ref="host" class="sql-editor" /></template>
