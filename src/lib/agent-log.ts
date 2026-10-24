import type { AgentLog, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma';
import { correlation } from './context';

export type AgentLogRow = Omit<Prisma.AgentLogUncheckedCreateInput, 'data'> & {
  data?: Record<string, unknown>;
};

/**
 * The only place that writes AgentLog rows: stamps the current request/cycle/job
 * ids into `data.correlation` so a row can be tied back to its log lines.
 */
export function writeAgentLog(row: AgentLogRow, db: Pick<PrismaClient, 'agentLog'> = prisma): Promise<AgentLog> {
  return db.agentLog.create({
    data: { ...row, data: { ...row.data, correlation: correlation() } as any },
  });
}
