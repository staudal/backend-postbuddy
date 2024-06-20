export const UserAlreadyExistsError = 'Der findes allerede en bruger med denne e-mail';
export const InternalServerError = 'Der opstod en fejl. Vi arbejder på at løse problemet';
export const UserNotFoundError = 'Brugeren findes ikke';
export const DesignNotFoundError = 'Designet findes ikke';
export const CampaignNotFoundError = 'Kampagnen findes ikke';
export const SegmentNotFoundError = 'Segmentet findes ikke';
export const ProfilesNotFoundError = 'Èn eller flere af profilerne findes ikke';
export const MissingRequiredParametersError = 'Mangler påkrævede parametre';
export const MissingSubscriptionError = 'Du har ikke et aktivt abonnement';
export const MissingShopifyIntegrationError = 'Brugeren har ikke tilknyttet en Shopify integration';
export const MissingAddressError = 'Brugeren har ikke tilknyttet en adresse';
export const InsufficientRightsError = 'Brugeren har ikke tilstrækkelige rettigheder til at udføre denne handling';
export const IntegrationNotFoundError = 'Du har ikke tilknyttet en integration af denne type';
export const CountryNotSupportedError = 'Dette land understøttes ikke';
export const FailedToBillUserError = 'Der opstod en fejl under faktureringen';
export const FailedToGeneratePdfError = 'Der opstod en fejl under genereringen af PDF\'en';
export const FailedToSendPdfToPrintPartnerError = 'Der opstod en fejl under afsendelsen af PDF\'en til printpartneren';
export const FailedToUpdateProfilesToSentError = 'Der opstod en fejl under opdateringen af profilerne til afsendt';
export const FailedToUpdateCampaignStatusError = 'Der opstod en fejl under opdateringen af kampagnens status';
export const FailedToCreateCampaignError = 'Der opstod en fejl under oprettelsen af kampagnen';
export const FailedToScheduleCampaignError = 'Der opstod en fejl under planlægningen af kampagnen';
export const MissingAuthorizationHeaderError = 'Manglende autorisationsheader';

export class ErrorWithStatusCode extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}