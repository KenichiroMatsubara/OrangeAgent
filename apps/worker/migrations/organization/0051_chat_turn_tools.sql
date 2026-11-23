-- An Operator Chat exchange keeps every tool its answer called, in order,
-- each failed one with why: a JSON array of `{ name, state, error? }`, so the
-- red chip of a failed call still says why when the conversation is opened
-- again, after the stream that first showed it has ended.
--
-- This only adds one column whose constant default is an empty array. No
-- existing row is read or rewritten; an exchange answered before it simply
-- shows no tools, as it did.
ALTER TABLE `chat_turns` ADD COLUMN `tools` text NOT NULL DEFAULT '[]';
