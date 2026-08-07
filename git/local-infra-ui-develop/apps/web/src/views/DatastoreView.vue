<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from '../ui';
import { api, post, type JsonRecord, type TableResult } from '../api';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';

type NamedRow = { name: string } & Record<string, unknown>;
const namespace = ref('default');
const kinds = ref<NamedRow[]>([]);
const kind = ref('');
const property = ref('');
const operator = ref('=');
const value = ref('');
const result = ref<TableResult | null>(null);
const entity = ref<JsonRecord | null>(null);
const logTail = ref(100);
const asText = (value: unknown) => (typeof value === 'string' ? value : String(value ?? ''));
const fail = (cause: unknown) => ElMessage.error(cause instanceof Error ? cause.message : 'Datastore request failed');
async function load() {
  try {
    kinds.value = (await api<TableResult>(`/datastore/kinds?namespace=${encodeURIComponent(namespace.value)}`))
      .rows as NamedRow[];
    kind.value ||= kinds.value[0]?.name ?? '';
    if (kind.value) await query();
  } catch (cause) {
    fail(cause);
  }
}
async function query() {
  try {
    result.value = await post<TableResult>('/datastore/query', {
      kind: kind.value,
      namespace: namespace.value,
      filter: property.value ? { property: property.value, operator: operator.value, value: value.value } : undefined,
    });
  } catch (cause) {
    fail(cause);
  }
}
async function detail(row: JsonRecord) {
  try {
    entity.value = (await api<{ entity: JsonRecord }>(`/datastore/entities/${asText(row.key)}`)).entity;
  } catch (cause) {
    fail(cause);
  }
}
onMounted(load);
</script>
<template>
  <section>
    <div class="workspace">
      <section class="panel">
        <header class="panel-header"><strong>Kind explorer</strong><PanelControls /></header>
        <div class="panel-body">
          <v-select
            v-model="namespace"
            :items="[{ title: '(default)', value: 'default' }]"
            @update:model-value="load"
          />
          <div class="list">
            <button
              v-for="item in kinds"
              :key="item.name"
              :class="{ active: kind === item.name }"
              @click="
                kind = item.name;
                query();
              "
            >
              ◇ {{ item.name }}
            </button>
          </div>
        </div>
      </section>
      <section class="panel">
        <header class="panel-header"><strong>Entity browser</strong><PanelControls /></header>
        <div class="panel-body">
          <div class="filter">
            <v-text-field v-model="property" label="Property" />
            <v-select v-model="operator" :items="['=', '>=', '<=']" aria-label="Operator" />
            <v-text-field v-model="value" label="Value" />
            <v-btn color="primary" variant="flat" @click="query">Apply filter</v-btn>
          </div>
          <el-table :data="result?.rows" stripe max-height="330" @row-click="detail"
            ><el-table-column
              v-for="column in result?.columns"
              :key="column.key"
              :prop="column.key"
              :label="column.label"
              min-width="140"
          /></el-table>
          <pre v-if="entity" class="raw">{{ JSON.stringify(entity, null, 2) }}</pre>
        </div>
      </section>
    </div>
    <LogPanel v-model:tail="logTail" title="Datastore emulator logs" url="/api/services/datastore/logs/events" />
  </section>
</template>
