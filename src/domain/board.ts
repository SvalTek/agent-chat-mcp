import { openDatabase } from "../storage/database.ts";
import { EventHub } from "./events.ts";
import { Accounts } from "./accounts.ts";
import { Categories } from "./categories.ts";
import { Messages } from "./messages.ts";
import { Follows } from "./follows.ts";
import { Inbox } from "./inbox.ts";
export type * from "./types.ts";
export { encodeReadCursor } from "../storage/pagination.ts";
export class BoardStore {
  readonly events = new EventHub();
  readonly authenticate: Accounts["authenticate"];
  readonly getAccount: Accounts["getAccount"];
  readonly resolveUsername: Accounts["resolveUsername"];
  readonly updateProfile: Accounts["updateProfile"];
  readonly listAgents: Accounts["listProfiles"];
  readonly getAgent: Accounts["getProfile"];
  readonly createCategory: Categories["createCategory"];
  readonly renameCategory: Categories["renameCategory"];
  readonly archiveCategory: Categories["archiveCategory"];
  readonly getCategory: Categories["getCategory"];
  readonly listCategories: Categories["listCategories"];
  readonly postThread: Messages["postThread"];
  readonly reply: Messages["reply"];
  readonly sendDm: Messages["sendDm"];
  readonly editMessage: Messages["editMessage"];
  readonly getThread: Messages["getThread"];
  readonly getMessage: Messages["getMessage"];
  readonly listThreads: Messages["listThreads"];
  readonly listMessages: Messages["listMessages"];
  readonly listFeed: Messages["listFeed"];
  readonly canReadDm: Messages["canReadDm"];
  readonly followThread: Follows["follow"];
  readonly unfollowThread: Follows["unfollow"];
  readonly listInbox: Inbox["listInbox"];
  readonly markInboxRead: Inbox["markInboxRead"];
  private constructor(readonly kv: Deno.Kv) {
    const accounts = new Accounts(kv);
    const categories = new Categories(kv, this.events);
    const follows = new Follows(kv);
    const messages = new Messages(kv, this.events, accounts, follows);
    const inbox = new Inbox(kv, messages, this.events);
    this.authenticate = accounts.authenticate.bind(accounts);
    this.getAccount = accounts.getAccount.bind(accounts);
    this.resolveUsername = accounts.resolveUsername.bind(accounts);
    this.updateProfile = accounts.updateProfile.bind(accounts);
    this.listAgents = accounts.listProfiles.bind(accounts);
    this.getAgent = accounts.getProfile.bind(accounts);
    this.createCategory = categories.createCategory.bind(categories);
    this.renameCategory = categories.renameCategory.bind(categories);
    this.archiveCategory = categories.archiveCategory.bind(categories);
    this.getCategory = categories.getCategory.bind(categories);
    this.listCategories = categories.listCategories.bind(categories);
    this.postThread = messages.postThread.bind(messages);
    this.reply = messages.reply.bind(messages);
    this.sendDm = messages.sendDm.bind(messages);
    this.editMessage = messages.editMessage.bind(messages);
    this.getThread = messages.getThread.bind(messages);
    this.getMessage = messages.getMessage.bind(messages);
    this.listThreads = messages.listThreads.bind(messages);
    this.listMessages = messages.listMessages.bind(messages);
    this.listFeed = messages.listFeed.bind(messages);
    this.canReadDm = messages.canReadDm.bind(messages);
    this.followThread = follows.follow.bind(follows);
    this.unfollowThread = follows.unfollow.bind(follows);
    this.listInbox = inbox.listInbox.bind(inbox);
    this.markInboxRead = inbox.markInboxRead.bind(inbox);
  }
  static async open(path: string) {
    return new BoardStore(await openDatabase(path));
  }
  close() {
    this.kv.close();
  }
}
