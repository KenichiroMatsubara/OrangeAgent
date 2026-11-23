import { useAccount } from '../dashboard';
import { PeopleSection } from '../people';
import { morePlaceGroups } from '../places';
import { List, Row } from '../ui/list';
import { Page, Section } from '../ui/page';

/** その他 reads nothing of its own: it is the list of everything the bottom tabs leave out. */
export const loader = async (): Promise<null> => null;

const More = () => {
  const { account } = useAccount();
  return <Page title="その他" lead={account.name}>
    {morePlaceGroups.map((group) => <Section key={group.title} title={group.title}>
      <List>
        {group.places.map((place) => <Row key={place.to} to={`../${place.to}`} leading={<place.icon size={20} aria-hidden="true" />} title={place.label} sub={place.sub} />)}
      </List>
    </Section>)}
    <PeopleSection />
  </Page>;
};

export default More;
