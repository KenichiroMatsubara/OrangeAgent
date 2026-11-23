/**
 * FlareChat's icon, the same file the browser tab, the home screen, and the
 * MCP Server name, shown beside the product's name wherever the GUI shows it.
 */
export const BrandMark = ({ size, className }: { size: number; className?: string | undefined }) =>
  <img className={className} src="/icon.svg" alt="" width={size} height={size} />;

/** The head of a card shown before or outside an Account: the icon, the name, and what the card is for. */
export const SetupBrand = ({ caption }: { caption: string }) => <div className="setup-brand">
  <BrandMark size={39} />
  <div><strong>FlareChat</strong><small>{caption}</small></div>
</div>;
