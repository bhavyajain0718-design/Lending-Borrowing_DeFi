// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Corn
/// @author Bhavya Jain
/// @notice Minimal ERC-20 token used as the debt asset in the lending protocol.
contract Corn {
    string public constant name = "Corn Token";
    string public constant symbol = "CORN";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isMinter;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event MinterUpdated(address indexed account, bool allowed);

    error NotOwner();
    error NotMinter();
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMinter() {
        if (!isMinter[msg.sender]) revert NotMinter();
        _;
    }

    /// @notice Initializes the token and grants the deployer owner and minter permissions.
    constructor() {
        owner = msg.sender;
        isMinter[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit MinterUpdated(msg.sender, true);
    }

    /// @notice Transfers contract ownership to a new address.
    /// @param newOwner Address that will become the new owner.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Grants or revokes minting and burning privileges for an account.
    /// @param account Account whose minter role is being updated.
    /// @param allowed Whether the account should be allowed to mint and burn.
    function setMinter(address account, bool allowed) external onlyOwner {
        isMinter[account] = allowed;
        emit MinterUpdated(account, allowed);
    }

    /// @notice Approves a spender to transfer tokens on behalf of the caller.
    /// @param spender Address allowed to spend the caller's tokens.
    /// @param amount Amount of tokens approved for spending.
    /// @return True when the approval succeeds.
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @notice Transfers tokens from the caller to another address.
    /// @param to Recipient of the tokens.
    /// @param amount Amount of tokens to transfer.
    /// @return True when the transfer succeeds.
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice Transfers tokens from one account to another using allowance.
    /// @param from Address providing the tokens.
    /// @param to Recipient of the tokens.
    /// @param amount Amount of tokens to transfer.
    /// @return True when the transfer succeeds.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, amount);
        return true;
    }

    /// @notice Mints new CORN to a recipient.
    /// @param to Recipient of the newly minted tokens.
    /// @param amount Amount of CORN to mint.
    function mint(address to, uint256 amount) external onlyMinter {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burns CORN from an address.
    /// @param from Address whose tokens will be burned.
    /// @param amount Amount of CORN to burn.
    function burn(address from, uint256 amount) external onlyMinter {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        balanceOf[from] = balance - amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        balanceOf[from] = balance - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
