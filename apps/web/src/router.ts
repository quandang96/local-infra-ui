import { createRouter, createWebHistory } from 'vue-router';
import OverviewView from './views/OverviewView.vue';
import MysqlView from './views/MysqlView.vue';
import GcloudView from './views/GcloudView.vue';
import DatastoreView from './views/DatastoreView.vue';
import KafkaView from './views/KafkaView.vue';
import KafkaUiView from './views/KafkaUiView.vue';
import SpannerView from './views/SpannerView.vue';
import TasksView from './views/TasksView.vue';
import SystemView from './views/SystemView.vue';
import DockerToolsView from './views/DockerToolsView.vue';
import AppServicesView from './views/AppServicesView.vue';
import ServiceView from './views/ServiceView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: OverviewView, meta: { title: 'Overview' } },
    { path: '/mysql', name: 'mysql', component: MysqlView, meta: { title: 'MySQL' } },
    { path: '/redash', redirect: '/mysql' },
    { path: '/gcloud', name: 'gcloud', component: GcloudView, meta: { title: 'gcloud CLI' } },
    { path: '/datastore', name: 'datastore', component: DatastoreView, meta: { title: 'Datastore' } },
    { path: '/kafka', name: 'kafka', component: KafkaView, meta: { title: 'Kafka' } },
    { path: '/kafka-ui', name: 'kafka-ui', component: KafkaUiView, meta: { title: 'Kafka UI' } },
    { path: '/spanner', name: 'spanner', component: SpannerView, meta: { title: 'Spanner' } },
    { path: '/tasks', name: 'tasks', component: TasksView, meta: { title: 'Task History' } },
    { path: '/system', name: 'system', component: SystemView, meta: { title: 'System' } },
    { path: '/docker', name: 'docker', component: DockerToolsView, meta: { title: 'Docker Tools' } },
    {
      path: '/app-services',
      name: 'app-services',
      component: AppServicesView,
      meta: { title: 'Application Services' },
    },
    { path: '/service/:serviceId', name: 'service', component: ServiceView, meta: { title: 'Compose Service' } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
