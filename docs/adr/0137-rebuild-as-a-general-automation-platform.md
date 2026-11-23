# Rebuild as a general automation platform

The product becomes a general automation platform with a conversational surface, scheduled execution, MCP tool binding, and multiple contact channels, and the Gmail-to-Calendar-and-LINE behaviour the product began as becomes one configuration of that platform rather than the product itself. The product had ruled chat, Agents, and MCP out of scope and omitted a general chat surface; both are reversed, because the platform can only reach the intended generality if those three are first-class.

Nothing is migrated by rewriting a Schema Rule into its general equivalent. Agent Rules are strengthened until they cover what Schema Rules do, at which point Schema Rules are deleted. Until that point both rule types exist side by side, so keeping them as two separate rule types remains correct rather than becoming debt, and the retreat path stays open if the general engine never matches a Schema Rule's predictability or cost.

## Consequences

The two rule types converge on one entity only at the end of the migration, not at its start, so no release in between should be judged against the unified model.

## Outcome

The migration ended with migration 0037. Every Schema Rule an Account still ran became an Agent Rule with the same selection, Execution Mode, priority, readers, and lists, run by a Prompt that states what the Schema Rule did, and the code that ran Schema Rules was deleted. Their tables were archived rather than dropped, for the reason ADR 0184 records.
