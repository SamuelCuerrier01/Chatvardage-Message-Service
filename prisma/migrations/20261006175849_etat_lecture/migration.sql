-- CreateEnum
CREATE TYPE "ConversationKind" AS ENUM ('dm', 'room');

-- CreateTable
CREATE TABLE "ConversationReadState" (
    "userId" TEXT NOT NULL,
    "kind" "ConversationKind" NOT NULL,
    "targetId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationReadState_pkey" PRIMARY KEY ("userId","kind","targetId")
);

-- CreateIndex
CREATE INDEX "ConversationReadState_kind_targetId_idx" ON "ConversationReadState"("kind", "targetId");
