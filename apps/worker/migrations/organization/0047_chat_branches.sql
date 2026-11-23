-- An Operator Chat conversation is a tree of exchanges: each one follows the
-- exchange it was asked after, and a message asked again from an earlier point
-- becomes a branch beside the one it replaces, which is kept.
--
-- Every conversation written before this was one line, each exchange appended
-- after the one with the next lower position (openChatTurn has always given a
-- new turn the conversation's highest position plus one, and position is NOT
-- NULL and unique per conversation). So each row follows the row just before
-- it, and the first row of a conversation follows none. The column is
-- nullable and unconstrained, so no row can fail it.
ALTER TABLE `chat_turns` ADD COLUMN `parent_turn_id` text;
--> statement-breakpoint
UPDATE `chat_turns` SET `parent_turn_id` = (
	SELECT `earlier`.`id` FROM `chat_turns` AS `earlier`
	WHERE `earlier`.`conversation_id` = `chat_turns`.`conversation_id` AND `earlier`.`position` < `chat_turns`.`position`
	ORDER BY `earlier`.`position` DESC
	LIMIT 1
);
