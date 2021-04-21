import { Injectable } from '@angular/core';
import { WalletService } from '../wallet/wallet.service';
import { of, Observable, from as fromPromise } from 'rxjs';
import { flatMap } from 'rxjs/operators';
import { Activity, Account, ImplicitAccount } from '../wallet/wallet';
import { MessageService } from '../message/message.service';
import { LookupService } from '../lookup/lookup.service';
import { IndexerService } from '../indexer/indexer.service';
import Big from 'big.js';
import { CONSTANTS } from '../../../environments/environment';
import { TokenService } from '../token/token.service';
import { TezosDomainsService } from '../tezos-domains/tezos-domains.service';

const localStoreTezosDomainKey = 'tezos-domains'

@Injectable()
export class ActivityService {
  maxTransactions = 10;
  private mapDomainAlias: Map<string, string> = new Map();
  constructor(
    private walletService: WalletService,
    private messageService: MessageService,
    private lookupService: LookupService,
    private indexerService: IndexerService,
    private tokenService: TokenService,
    private tezosDomains: TezosDomainsService,
  ) {
    this.mapDomainAlias = new Map(JSON.parse(localStorage.getItem(localStoreTezosDomainKey) || '[]'))
    this.clearNoDomains()
  }
  updateTransactions(pkh): Observable<any> {
    try {
      const account = this.walletService.wallet.getAccount(pkh);
      return this.getTransactonsCounter(account).pipe(
        flatMap((ans: any) => {
          return of(ans);
        })
      );
    } catch (e) {
      console.log(e);
    }
  }
  getTransactonsCounter(account: Account): Observable<any> {
    // update for tezos domains
    const aryDestinationAddress = account.activities
      .filter((val, idx, ary) => val.type === 'transaction')
      .map(trx => trx?.destination?.address)
    const arySourceAddress = account.activities
      .filter((val, idx, ary) => val.type === 'transaction')
      .map(trx => trx?.source?.address)

    // also add all implicit accounts to the list
    const aryImplicitAddress = this.walletService.wallet.getAccounts().map(a => a.address)

    const aryAllAddress = [].concat(aryDestinationAddress).concat(arySourceAddress).concat(aryImplicitAddress)
    for (const pkh of aryAllAddress.filter((val, idx, ary) => ary.indexOf(val) === idx)) {
      this.fetchDomainAlias(pkh)
    }


    const knownTokenIds: string[] = this.tokenService.knownTokenIds();
    return fromPromise(this.indexerService.accountInfo(account.address, knownTokenIds)).pipe(
      flatMap((data) => {
        const counter = data.counter;
        const unknownTokenIds = data.unknownTokenIds ? data.unknownTokenIds : [];
        this.handleUnknownTokenIds(unknownTokenIds);
        if (account.state !== counter) {
          if (data.tokens) {
            this.updateTokenBalances(account, data.tokens);
          }
          return this.getAllTransactions(account, counter);
        } else {
          return of({
            upToDate: true,
          });
        }
      })
    );
  }
  private handleUnknownTokenIds(unknownTokenIds) {
    if (unknownTokenIds.length) {
      for (const tokenId of unknownTokenIds) {
        const tok = tokenId.split(':');
        this.tokenService.searchMetadata(tok[0], tok[1]);
      }
    }
  }
  async updateTokenBalances(account, tokens) {
    if (tokens && tokens.length) {
      for (const token of tokens) {
        const tokenId = `${token.contract}:${token.token_id}`;
        if (tokenId) {
          account.updateTokenBalance(tokenId, token.balance.toString());
        }
      }
    }
    this.walletService.storeWallet();
  }
  getAllTransactions(account: Account, counter: string): Observable<any> {
    const knownTokenIds: string[] = this.tokenService.knownTokenIds();
    return fromPromise(this.indexerService.getOperations(account.address, knownTokenIds, this.walletService.wallet)).pipe(
      flatMap((resp) => {
        const operations = resp.operations;
        this.handleUnknownTokenIds(resp.unknownTokenIds);
        if (Array.isArray(operations)) {
          const oldActivities = account.activities;
          account.activities = operations;
          const oldState = account.state;
          account.state = counter;
          this.walletService.storeWallet();
          if (oldState !== '') { // Exclude inital loading
            this.promptNewActivities(account, oldActivities, operations);
          } else {
            console.log('# Excluded ' + counter);
          }
          for (const activity of operations) {
            const counterParty = this.getCounterparty(activity, account, false);
            this.lookupService.check(counterParty);
          }
        } else {
          console.log(operations);
        }
        return of({
          upToDate: false
        });
      })
    );
  }
  promptNewActivities(account: Account, oldActivities: Activity[], newActivities: Activity[]) {
    for (const activity of newActivities) {
      const index = oldActivities.findIndex((a) => a.hash === activity.hash);
      if (index === -1 || (index !== -1 && oldActivities[index].status === 0)) {
        const now = (new Date()).getTime();
        const timeDiff = now - (activity?.timestamp ? activity.timestamp : now);
        if (timeDiff < 3600000) { // 1 hour
          if (activity.type === 'transaction') {
            if (account.address === activity.source.address) {
              this.messageService.addSuccess(account.shortAddress() + ': Sent ' + this.tokenService.formatAmount(activity.tokenId, activity.amount.toString()));
            }
            if (account.address === activity.destination.address) {
              this.messageService.addSuccess(account.shortAddress() + ': Received ' + this.tokenService.formatAmount(activity.tokenId, activity.amount.toString()));
            }
          } else if (activity.type === 'delegation') {
            this.messageService.addSuccess(account.shortAddress() + ': Delegate updated');
          } else if (activity.type === 'origination') {
            this.messageService.addSuccess(account.shortAddress() + ': Contract originated');
          } else if (activity.type === 'activation') {
            this.messageService.addSuccess(account.shortAddress() + ': Account activated');
          }
        }
      }
    }
  }
  getCounterparty(transaction: Activity, account: Account, withLookup = true): string {
    let counterParty = { address: '' };
    let counterPartyAddress = '';
    if (transaction.type === 'delegation') {
      if (transaction.destination) {
        counterParty = transaction.destination;
      } else {
        counterParty = { address: '' }; // User has undelegated
      }
    } else if (transaction.type === 'transaction') {
      if (account.address === transaction.source.address) {
        counterParty = transaction.destination; // to
      } else {
        counterParty = transaction.source; // from
      }
    } else if (transaction.type === 'origination') {
      if (account.address === transaction.source.address) {
        counterParty = transaction.destination;
      } else {
        counterParty = transaction.source;
      }
    } else {
      counterParty = { address: '' };
    }
    if (withLookup) {
      counterPartyAddress = this.lookupService.resolve(counterParty);
    }
    return counterPartyAddress;
  }

  clearNoDomains() {
    // Every 5 min clear the map so that it can re-fetch in case anyone gets a domain
    setTimeout(() => {
      const aryRemoveKey = []
      for (const [key, value] of this.mapDomainAlias.entries()) {
        if (!value) {
          aryRemoveKey.push(key)
        }
      }
      for (const key of aryRemoveKey) {
        this.mapDomainAlias.delete(key)
      }
      this.clearNoDomains()
    }, 5 * 60 * 1000);
  }
  fetchDomainAlias(pkh: string) {
    if (!this.mapDomainAlias.has(pkh)) {
      this.tezosDomains
        .getDomainFromAddress(pkh)
        .then((domain) => {
          this.mapDomainAlias.set(pkh, domain);
          localStorage.setItem(localStoreTezosDomainKey, JSON.stringify([...this.mapDomainAlias.entries()]))
        }).catch((err) => {
          console.error(err.message);
        });
    }
  }
  getDomainAlias(pkh) {
    return this.mapDomainAlias.get(pkh)
  }
}
