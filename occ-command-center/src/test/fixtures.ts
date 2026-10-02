/**
 * 测试夹具
 *
 * 只给测试用。形状必须和后端真实返回一致——夹具一旦和契约漂了，
 * 测试就会开始为不存在的数据鼓掌。
 */

import type { AgentAudit } from '../api/gateway';

/**
 * Agent 审计投影夹具
 *
 * 对应「一次读数据库 → 两次数据分析 → 生成图表」的执行过程。
 * 时间戳在这里给全了：真实 checkpoint 不记每次调用的时间，前端会用调用序位兜底，
 * 那条路径另有测试覆盖。
 */
export function auditFixture(): AgentAudit {
  return {
    available: true,
    // 这份夹具装的是**智能体**那一套（多卡：完整的人机交互）。
    // 形状由后端那句 `kind` 定，前端不自己推
    kind: 'agent',
    source: 'langgraph-checkpoint',
    read_at: '2025-01-26T09:30:00Z',
    calls: [
      {
        call_id: 'call-001-1',
        tool_id: 'read_database',
        args: { query: 'SELECT * FROM feedback WHERE created_at > NOW() - INTERVAL 30 DAY' },
        status: 'completed',
        result: { rows: 1247, status: 'success' },
        timestamp: '2025-01-26T09:00:15Z',
        context_refs: ['db-conn-1'],
      },
      {
        call_id: 'call-001-2',
        tool_id: 'data_analysis',
        args: { data_source: 'feedback_table', analysis_type: 'sentiment' },
        status: 'completed',
        result: { positive: 650, negative: 200, neutral: 397 },
        timestamp: '2025-01-26T09:15:30Z',
        context_refs: ['call-001-1'],
      },
      {
        call_id: 'call-001-3',
        tool_id: 'data_analysis',
        args: { data_source: 'feedback_table', analysis_type: 'topic_extraction' },
        status: 'completed',
        result: { topics: ['UI/UX', 'Performance', 'Features', 'Bugs'] },
        timestamp: '2025-01-26T09:20:00Z',
        context_refs: ['call-001-1'],
      },
      {
        call_id: 'call-001-4',
        tool_id: 'generate_chart',
        args: { chart_type: 'bar', data: 'sentiment_analysis' },
        status: 'pending',
        timestamp: '2025-01-26T09:25:00Z',
      },
    ],
    /*
      **完整消息序列**——`calls` 只是它折出来的工具视角。少了这一份，
      系统提示、**人的输入**、模型每一次说的话（尤其最后那段结论）就都没了。
    */
    turns: [
      { role: 'system', text: '你是 OCC 的执行者，用给你的工具把事做完。' },
      { role: 'human', text: '查一下上个月的反馈' },
      {
        role: 'ai', text: '我先看一眼数据库里有多少条。',
        calls: [{ call_id: 'call-001-1', tool_id: 'read_database', args: { query: 'SELECT count(*) FROM feedback' } }],
      },
      { role: 'tool', text: '{"rows": 1247}', tool_id: 'read_database', status: 'success' },
      { role: 'ai', text: '上个月一共 1247 条反馈。' },
    ],
  };
}
