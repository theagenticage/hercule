/**
 * Conversations: exchanges in one channel container, and the messages in
 * them. A plain messenger: it stores what is said and hands each sent message
 * to whoever answers, through `ConversationResponder`. It knows the answering
 * party only as an id.
 */
export { ConversationService, ConversationServiceLayer } from "./service";
export { ConversationMessages, ConversationMessagesLayer } from "./conversation-messages";
export { ConversationResponder, type ResponderError } from "./responder";
