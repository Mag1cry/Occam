/**
 * Configuration Mock 数据
 *
 * 外层只有一个配置舱入口节点。Executor Configuration、Extension 和
 * Capability 都是子场景资料，不在外层出现。
 *
 * 合法关系只有：
 *   Extension → Capability            （declares）
 *   Task      → Executor Configuration（有真实 Task 引用时）
 * 不生成 Configuration → Capability 绑定。
 */

import type { ResourceNode } from '../core/types/node';

/** Executor Configuration（子场景资料） */
export const mockExecutorConfigurations: ResourceNode[] = [
  {
    type: 'resource',
    id: 'config-001',
    resource_kind: 'executor-config',
    label: 'Standard Executor',
    x: 0,
    y: 0,
    summary: '标准执行器配置，使用默认工具集',
  },
  {
    type: 'resource',
    id: 'config-002',
    resource_kind: 'executor-config',
    label: 'Production Deployer',
    x: 0,
    y: 0,
    summary: '生产环境部署配置，包含部署权限',
  },
  {
    type: 'resource',
    id: 'config-003',
    resource_kind: 'executor-config',
    label: 'Data Manager',
    x: 0,
    y: 0,
    summary: '数据管理配置，具有数据库访问权限',
  },
  {
    type: 'resource',
    id: 'config-004',
    resource_kind: 'executor-config',
    label: 'Backup Agent',
    x: 0,
    y: 0,
    summary: '备份专用配置，具有存储访问权限',
  },
  {
    type: 'resource',
    id: 'config-005',
    resource_kind: 'executor-config',
    label: 'Payment Handler',
    x: 0,
    y: 0,
    summary: '支付处理配置，包含支付网关工具',
  },
  {
    // 引用是**带供应商作用域**的（后端 `ExecutorConfigurationRef.qualified`：
    // `provider:profile`），被用户停用的这条按这个形状给——配置舱要从引用里
    // 认出它属于哪一家，才能把它放回那个供应商名下
    type: 'resource',
    id: 'uniapi:legacy-research',
    resource_kind: 'executor-config',
    label: 'Legacy Research',
    x: 0,
    y: 0,
    summary: '研究用配置，已被用户停用',
  },
];

/** Extension（子场景资料） */
export const mockExtensions: ResourceNode[] = [
  {
    type: 'resource',
    id: 'ext-001',
    resource_kind: 'extension',
    label: 'AWS Extension',
    x: 0,
    y: 0,
    summary: 'AWS 云服务扩展',
  },
  {
    type: 'resource',
    id: 'ext-002',
    resource_kind: 'extension',
    label: 'Database Extension',
    x: 0,
    y: 0,
    summary: '数据库访问扩展',
  },
  {
    type: 'resource',
    id: 'ext-003',
    resource_kind: 'extension',
    label: 'Payment Extension',
    x: 0,
    y: 0,
    summary: '支付网关扩展',
  },
  {
    // 只声明执行者、不声明任何工具的包：它没有可上下线的东西
    // （真实目录里的 _providers 那两家就是这一类）
    type: 'resource',
    id: 'ext-004',
    resource_kind: 'extension',
    label: 'Executor Pack',
    x: 0,
    y: 0,
    summary: '只声明执行者配置的包',
  },
];

/** Capability manifest（子场景资料） */
export const mockCapabilities: ResourceNode[] = [
  {
    type: 'resource',
    id: 'cap-001',
    resource_kind: 'capability',
    label: 'S3 Storage',
    x: 0,
    y: 0,
    summary: 'AWS S3 存储操作能力',
  },
  {
    type: 'resource',
    id: 'cap-002',
    resource_kind: 'capability',
    label: 'EC2 Management',
    x: 0,
    y: 0,
    summary: 'AWS EC2 实例管理能力',
  },
  {
    type: 'resource',
    id: 'cap-003',
    resource_kind: 'capability',
    label: 'PostgreSQL Query',
    x: 0,
    y: 0,
    summary: 'PostgreSQL 数据库查询能力',
  },
  {
    type: 'resource',
    id: 'cap-004',
    resource_kind: 'capability',
    label: 'Stripe Payment',
    x: 0,
    y: 0,
    summary: 'Stripe 支付处理能力',
  },
];

/** Extension → Capability 的显式声明映射 */
export const mockExtensionCapabilities: Record<string, string[]> = {
  'ext-001': ['cap-001', 'cap-002'],
  'ext-002': ['cap-003'],
  'ext-003': ['cap-004'],
};
