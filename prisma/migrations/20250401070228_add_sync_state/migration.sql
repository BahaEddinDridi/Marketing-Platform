-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "deltaLink" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_user_id_key" ON "SyncState"("user_id");

-- CreateIndex
CREATE INDEX "SyncState_user_id_platform_idx" ON "SyncState"("user_id", "platform");
