import { createFileRoute } from '@tanstack/react-router';

import { staticPageRouteOptions } from './-static-page';

export const Route = createFileRoute('/(pages)/acceptable-use-policy')(
  staticPageRouteOptions('acceptable-use-policy')
);
