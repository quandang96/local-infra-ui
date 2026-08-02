import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { api, type Service } from '../api';

export type TaskRecord = {
  id: string;
  service_id: string;
  action_id: string;
  status: string;
  created_at: string;
  duration_ms?: number;
};
export type Overview = {
  system: {
    cpuCores?: number;
    uptimeSeconds?: number;
    memory?: { total?: number; used?: number; available?: number; processRss?: number };
    docker?: { LayersSize?: number };
  };
  counts: { running?: number; totalDaemons?: number; unhealthy?: number };
  services: Service[];
};

export const useInfraStore = defineStore('infra', () => {
  const overview = ref<Overview>({ system: {}, counts: {}, services: [] });
  const services = ref<Service[]>([]);
  const tasks = ref<TaskRecord[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const connected = computed(() => !error.value);

  async function refresh() {
    loading.value = true;
    try {
      const [nextOverview, taskHistory] = await Promise.all([
        api<Overview>('/overview'),
        api<{ rows: TaskRecord[] }>('/tasks/history'),
      ]);
      overview.value = nextOverview;
      services.value = nextOverview.services;
      tasks.value = taskHistory.rows;
      error.value = null;
    } catch (cause: unknown) {
      error.value = cause instanceof Error ? cause.message : 'Không thể kết nối backend';
    } finally {
      loading.value = false;
    }
  }

  return { overview, services, tasks, loading, error, connected, refresh };
});
