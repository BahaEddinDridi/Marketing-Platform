/*
  Warnings:

  - A unique constraint covering the columns `[orgId,email,initialConversationId]` on the table `Lead` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "initialConversationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Lead_orgId_email_initialConversationId_key" ON "Lead"("orgId", "email", "initialConversationId");
